const GdPrivate = imports.gi.GdPrivate;
const Gio = imports.gi.Gio;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const ErrorBox = imports.errorBox;
const FullscreenAction = imports.fullscreenAction;
const MainToolbar = imports.mainToolbar;
const Password = imports.password;
const Properties = imports.properties;
const Searchbar = imports.searchbar;
const Utils = imports.utils;

const _ICON_SIZE = 32;
const _PDF_LOADER_TIMEOUT = 400;

var Preview = new Lang.Class({
    Name: 'Preview',
    Extends: Gtk.Stack,

    _init: function(overlay, mainWindow) {
        this._lastSearch = '';
        this._loadShowId = 0;
        this._controlsFlipId = 0;
        this._controlsVisible = false;
        this._fsStateId = 0;
        this._fsToolbar = null;
        this.overlay = overlay;
        this.mainWindow = mainWindow;

        this.parent({ homogeneous: true,
                      transition_type: Gtk.StackTransitionType.CROSSFADE });

        this.actionGroup = this._createActionGroup();

        this._errorBox = new ErrorBox.ErrorBox();
        this.add_named(this._errorBox, 'error');

        this._spinner = new Gtk.Spinner({ width_request: _ICON_SIZE,
                                          height_request: _ICON_SIZE,
                                          halign: Gtk.Align.CENTER,
                                          valign: Gtk.Align.CENTER });
        this.add_named(this._spinner, 'spinner');

        this.view = this.createView();
        this.add_named(this.view, 'view');
        this.view.show();
        this.set_visible_child_full('view', Gtk.StackTransitionType.NONE);

        this.toolbar = this.createToolbar();

        this.contextMenu = this.createContextMenu();
        if (this.contextMenu)
            this.contextMenu.attach_to_widget(this.view, null);

        this.navControls = this.createNavControls();
        this.navControls.show();
        this.show_all();

        this._loadStartedId = Application.documentManager.connect('load-started',
                                                                  Lang.bind(this, this.onLoadStarted));
        this._loadFinishedId = Application.documentManager.connect('load-finished',
                                                                   Lang.bind(this, this.onLoadFinished));
        this._loadErrorId = Application.documentManager.connect('load-error',
                                                                Lang.bind(this, this.onLoadError));
        this._passwordNeededId = Application.documentManager.connect('password-needed',
                                                                     Lang.bind(this, this.onPasswordNeeded));

        this._nightModeId = Application.application.connect('action-state-changed::night-mode',
            Lang.bind(this, this._updateNightMode));

        this.connect('destroy', Lang.bind(this,
            function() {
                if (this._loadStartedId > 0) {
                    Application.documentManager.disconnect(this._loadStartedId);
                    this._loadStartedId = 0;
                }
                if (this._loadFinishedId > 0) {
                    Application.documentManager.disconnect(this._loadFinishedId);
                    this._loadFinishedId = 0;
                }
                if (this._loadErrorId > 0) {
                    Application.documentManager.disconnect(this._loadErrorId);
                    this._loadErrorId = 0;
                }
                if (this._passwordNeededId > 0) {
                    Application.documentManager.disconnect(this._passwordNeededId);
                    this._passwordNeededId = 0;
                }
                if (this.navControls) {
                    this.navControls.destroy();
                    this.navControls = null;
                }

                if (this._fsToolbar) {
                    this._fsToolbar.destroy();
                    this._fsToolbar = null;
                }

                if (this._fullscreenAction) {
                    this._fullscreenAction.change_state(new GLib.Variant('b', false));
                    this._fullscreenAction.disconnect(this._fsStateId);
                }

                if (this._nightModeId > 0) {
                    Application.application.disconnect(this._nightModeId);
                    this._nightModeId = 0;
                }
            }));
    },

    _getDefaultActions: function() {
        let backAccels = ['Back'];
        if (this.get_direction() == Gtk.TextDirection.LTR)
            backAccels.push('<Alt>Left');
        else
            backAccels.push('<Alt>Right');

        return [
            { name: 'gear-menu',
              callback: Utils.actionToggleCallback,
              state: GLib.Variant.new('b', false),
              accels: ['F10'] },
            { name: 'properties',
              callback: Lang.bind(this, this._properties) },
            { name: 'open-current',
              callback: Lang.bind(this, this._openCurrent) },
            { name: 'prev-page',
              callback: Lang.bind(this, this.goPrev),
              accels: ['<Primary>Page_Up', 'Left'] },
            { name: 'next-page',
              callback: Lang.bind(this, this.goNext),
              accels: ['<Primary>Page_Down', 'Right'] },
            { name: 'go-back',
              callback: Lang.bind(this, this.goBack),
              accels: backAccels }
        ];
    },

    _properties: function() {
        let doc = Application.documentManager.getActiveItem();
        if (!doc)
            return;

        let dialog = new Properties.PropertiesDialog(doc.id);
        dialog.connect('response', Lang.bind(this, function(widget, response) {
            widget.destroy();
        }));
    },

    _openCurrent: function() {
        let doc = Application.documentManager.getActiveItem();
        if (doc)
            doc.open(this.mainWindow, Gtk.get_current_event_time());
    },

    _updateNightMode: function() {
        this.nightMode = Application.settings.get_boolean('night-mode');
    },

    _onFullscreenChanged: function(action) {
        let fullscreen = action.state.get_boolean();

        this.toolbar.visible = !fullscreen;
        this.getAction('gear-menu').change_state(GLib.Variant.new('b', false));

        if (fullscreen) {
            // create fullscreen toolbar (hidden by default)
            this._fsToolbar = this.createFullscreenToolbar();
            this.overlay.add_overlay(this._fsToolbar);

            this._fsToolbar.connect('show-controls', Lang.bind(this, function() {
                this.controlsVisible = true;
            }));

            Application.application.set_accels_for_action('view.fullscreen',
                                                          ['F11', 'Escape']);
        } else {
            this._fsToolbar.destroy();
            this._fsToolbar = null;

            Application.application.set_accels_for_action('view.fullscreen', ['F11']);
        }

        this._syncControlsVisible();
    },

    getFullscreenToolbar: function() {
        return this._fsToolbar;
    },

    get controlsVisible() {
        return this._controlsVisible;
    },

    set controlsVisible(visible) {
        // reset any pending timeout, as we're about to change controls state
        this.cancelControlsFlip();

        if (this._controlsVisible == visible)
            return;

        this._controlsVisible = visible;
        this._syncControlsVisible();
    },

    _flipControlsTimeout: function() {
        this._controlsFlipId = 0;
        let visible = this.controlsVisible;
        this.controlsVisible = !visible;

        return false;
    },

     queueControlsFlip: function() {
         if (this._controlsFlipId)
             return;

         let settings = Gtk.Settings.get_default();
         let doubleClick = settings.gtk_double_click_time;

         this._controlsFlipId = Mainloop.timeout_add(doubleClick, Lang.bind(this, this._flipControlsTimeout));
     },

     cancelControlsFlip: function() {
         if (this._controlsFlipId != 0) {
             Mainloop.source_remove(this._controlsFlipId);
             this._controlsFlipId = 0;
         }
     },

    _syncControlsVisible: function() {
        if (this._controlsVisible) {
            if (this._fsToolbar)
                this._fsToolbar.reveal();
        } else {
            if (this._fsToolbar)
                this._fsToolbar.conceal();
        }
    },

    _createActionGroup: function() {
        let actions = this.createActions().concat(this._getDefaultActions());
        let actionGroup = new Gio.SimpleActionGroup();
        Utils.populateActionGroup(actionGroup, actions, 'view');

        if (this.canFullscreen) {
            this._fullscreenAction = new FullscreenAction.FullscreenAction({ window: this.mainWindow });
            this._fsStateId = this._fullscreenAction.connect('notify::state', Lang.bind(this, this._onFullscreenChanged));
            actionGroup.add_action(this._fullscreenAction);
            Application.application.set_accels_for_action('view.fullscreen', ['F11']);
        }

        return actionGroup;
    },

    createActions: function() {
        return [];
    },

    createNavControls: function() {
        return new PreviewNavControls(this, this.overlay);
    },

    activateResult: function() {
        this.findNext();
    },

    createFullscreenToolbar: function() {
        return new PreviewFullscreenToolbar(this);
    },

    createToolbar: function() {
        return new PreviewToolbar(this);
    },

    createView: function() {
        throw(new Error('Not implemented'));
    },

    createContextMenu: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Documents/ui/preview-context-menu.ui');
        let model = builder.get_object('preview-context-menu');
        return Gtk.Menu.new_from_model(model);
    },

    _clearLoadTimer: function() {
        if (this._loadShowId != 0) {
            Mainloop.source_remove(this._loadShowId);
            this._loadShowId = 0;
        }
    },

    onPasswordNeeded: function(manager, doc) {
        this._clearLoadTimer();
        this._spinner.stop();

        let dialog = new Password.PasswordDialog(doc);
        dialog.connect('response', Lang.bind(this, function(widget, response) {
            dialog.destroy();
            if (response == Gtk.ResponseType.CANCEL || response == Gtk.ResponseType.DELETE_EVENT)
                Application.documentManager.setActiveItem(null);
        }));
    },

    onLoadStarted: function(manager, doc) {
        this._clearLoadTimer();
        this._loadShowId = Mainloop.timeout_add(_PDF_LOADER_TIMEOUT, Lang.bind(this, function() {
            this._loadShowId = 0;

            this.set_visible_child_name('spinner');
            this._spinner.start();
            return false;
        }));
    },

    onLoadFinished: function(manager, doc) {
        this._clearLoadTimer();
        this._spinner.stop();

        this.set_visible_child_name('view');
        this.getAction('open-current').enabled = (doc.defaultAppName != null);
        this._updateNightMode();
    },

    onLoadError: function(manager, doc, message, exception) {
        this._clearLoadTimer();
        this._spinner.stop();

        this._errorBox.update(message, exception.message);
        this.set_visible_child_name('error');
    },

    getAction: function(name) {
        return this.actionGroup.lookup_action(name);
    },

    goBack: function() {
        Application.documentManager.setActiveItem(null);
        Application.modeController.goBack();
    },

    goPrev: function() {
        throw (new Error('Not implemented'));
    },

    goNext: function() {
        throw (new Error('Not implemented'));
    },

    get hasPages() {
        return false;
    },

    get page() {
        return 0;
    },

    get numPages() {
        return 0;
    },

    search: function(str) {
        this._lastSearch = str;
    },

    get lastSearch() {
        return this._lastSearch;
    },

    get fullscreen() {
        if (!this.canFullscreen)
            return false;

        return this.getAction('fullscreen').state.get_boolean();
    },

    get canFullscreen() {
        return false;
    },

    set nightMode(v) {
        // do nothing
    },

    findPrev: function() {
        throw (new Error('Not implemented'));
    },

    findNext: function() {
        throw (new Error('Not implemented'));
    }
});

var PreviewToolbar = new Lang.Class({
    Name: 'PreviewToolbar',
    Extends: MainToolbar.MainToolbar,

    _init: function(preview) {
        this._fsStateId = 0;
        this.preview = preview;

        this.parent();
        this.toolbar.set_show_close_button(true);

        // back button, on the left of the toolbar
        this.addBackButton();

        // menu button, on the right of the toolbar
        let menuButton = new Gtk.MenuButton({ image: new Gtk.Image ({ icon_name: 'view-more-symbolic' }),
                                              menu_model: this._getPreviewMenu(),
                                              action_name: 'view.gear-menu' });
        this.toolbar.pack_end(menuButton);

        if (this.preview.canFullscreen && Application.application.isBooks) {
            this._addFullscreenButton();
            this._addNightmodeButton();
        }

        this.updateTitle();
        this.toolbar.show_all();

        this.connect('destroy', Lang.bind(this, function() {
            if (this._fsStateId > 0)
                this.preview.getAction('fullscreen').disconnect(this._fsStateId);
        }));
    },

    _getPreviewMenu: function() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Documents/ui/preview-menu.ui');
        let menu = builder.get_object('preview-menu');

        let doc = Application.documentManager.getActiveItem();
        if (doc && doc.defaultAppName) {
            let section = builder.get_object('open-section');
            section.remove(0);
            section.prepend(_("Open with %s").format(doc.defaultAppName), 'view.open-current');
        }

        return menu;
    },

    _addNightmodeButton: function() {
        let nightmodeButton = new Gtk.ToggleButton({ image: new Gtk.Image ({ icon_name: 'display-brightness-symbolic' }),
                                                     tooltip_text: _("Night Mode"),
                                                     action_name: 'app.night-mode',
                                                     visible: true });
        this.toolbar.pack_end(nightmodeButton);
        return nightmodeButton;
    },

    _addFullscreenButton: function() {
        this._fullscreenButton = new Gtk.Button({ image: new Gtk.Image ({ icon_name: 'view-fullscreen-symbolic' }),
                                                  tooltip_text: _("Fullscreen"),
                                                  action_name: 'view.fullscreen',
                                                  visible: true });
        this.toolbar.pack_end(this._fullscreenButton);

        let action = this.preview.getAction('fullscreen');
        this._fsStateId = action.connect('notify::state', Lang.bind(this, this._fullscreenStateChanged));
        this._fullscreenStateChanged();
    },

    _fullscreenStateChanged: function() {
        let action = this.preview.getAction('fullscreen');
        let fullscreen = action.state.get_boolean();

        if (fullscreen)
            this._fullscreenButton.image.icon_name = 'view-restore-symbolic';
        else
            this._fullscreenButton.image.icon_name = 'view-fullscreen-symbolic';
    },

    createSearchbar: function() {
        return new PreviewSearchbar(this.preview);
    },

    updateTitle: function() {
        let primary = null;
        let doc = Application.documentManager.getActiveItem();

        if (doc)
            primary = doc.name;

        this.toolbar.set_title(primary);
    }
});

const PreviewFullscreenToolbar = new Lang.Class({
    Name: 'PreviewFullscreenToolbar',
    Extends: Gtk.Revealer,
    Signals: {
        'show-controls': {}
    },

    _init: function(preview) {
        this.parent({ valign: Gtk.Align.START });

        this.toolbar = preview.createToolbar();

        this.add(this.toolbar);
        this.show();

        // make controls show when a toolbar action is activated in fullscreen
        let actionNames = ['gear-menu', 'find'];
        let signalIds = [];

        actionNames.forEach(Lang.bind(this, function(actionName) {
            let signalName = 'action-state-changed::' + actionName;
            let signalId = preview.actionGroup.connect(signalName, Lang.bind(this,
                function(actionGroup, actionName, value) {
                    let state = value.get_boolean();
                    if (state)
                        this.emit('show-controls');
                }));

            signalIds.push(signalId);
        }));

        this.toolbar.connect('destroy', Lang.bind(this, function() {
            signalIds.forEach(function(signalId) {
                preview.actionGroup.disconnect(signalId);
            });
        }));
    },

    handleEvent: function(event) {
        this.toolbar.handleEvent(event);
    },

    reveal: function() {
        this.set_reveal_child(true);
    },

    conceal: function() {
        this.set_reveal_child(false);
        this.toolbar.preview.getAction('find').change_state(GLib.Variant.new('b', false));
    }
});

const _AUTO_HIDE_TIMEOUT = 2;
var PREVIEW_NAVBAR_MARGIN = 30;

var PreviewNavControls = new Lang.Class({
    Name: 'PreviewNavControls',

    _init: function(preview, overlay) {
        this._barRevealer = null;
        this.preview = preview;
        this._overlay = overlay;

        this._visible = false;
        this._visibleInternal = false;
        this._autoHideId = 0;
        this._motionId = 0;

        this.barWidget = this.createBarWidget();
        if (this.barWidget) {
            this._barRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.CROSSFADE,
                                                   margin: PREVIEW_NAVBAR_MARGIN,
                                                   valign: Gtk.Align.END });
            this._overlay.add_overlay(this._barRevealer);

            this.barWidget.get_style_context().add_class('osd');
            this._barRevealer.add(this.barWidget);
            this.barWidget.connect('notify::hover', Lang.bind(this, function() {
                if (this.barWidget.hover)
                    this._onEnterNotify();
                else
                    this._onLeaveNotify();
            }));

            this._barRevealer.show_all();
        }

        this._prevRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.CROSSFADE,
                                                margin_start: PREVIEW_NAVBAR_MARGIN,
                                                margin_end: PREVIEW_NAVBAR_MARGIN,
                                                halign: Gtk.Align.START,
                                                valign: Gtk.Align.CENTER });
        this._overlay.add_overlay(this._prevRevealer);

        let prevButton = new Gtk.Button({ image: new Gtk.Image ({ icon_name: 'go-previous-symbolic',
                                                                  pixel_size: 16 }), });
        prevButton.get_style_context().add_class('osd');
        this._prevRevealer.add(prevButton);
        prevButton.connect('clicked', Lang.bind(this, this._onPrevClicked));
        prevButton.connect('enter-notify-event', Lang.bind(this, this._onEnterNotify));
        prevButton.connect('leave-notify-event', Lang.bind(this, this._onLeaveNotify));

        this._nextRevealer = new Gtk.Revealer({ transition_type: Gtk.RevealerTransitionType.CROSSFADE,
                                                margin_start: PREVIEW_NAVBAR_MARGIN,
                                                margin_end: PREVIEW_NAVBAR_MARGIN,
                                                halign: Gtk.Align.END,
                                                valign: Gtk.Align.CENTER });
        this._overlay.add_overlay(this._nextRevealer);

        let nextButton = new Gtk.Button({ image: new Gtk.Image ({ icon_name: 'go-next-symbolic',
                                                                  pixel_size: 16 }) });
        nextButton.get_style_context().add_class('osd');
        this._nextRevealer.add(nextButton);
        nextButton.connect('clicked', Lang.bind(this, this._onNextClicked));
        nextButton.connect('enter-notify-event', Lang.bind(this, this._onEnterNotify));
        nextButton.connect('leave-notify-event', Lang.bind(this, this._onLeaveNotify));

        this._prevRevealer.show_all();
        this._nextRevealer.show_all();

        this._overlay.connect('motion-notify-event', Lang.bind(this, this._onMotion));

        this._tapGesture = new Gtk.GestureMultiPress({ propagation_phase: Gtk.PropagationPhase.CAPTURE,
                                                       touch_only: true,
                                                       widget: this.preview.view });
        this._tapGesture.connect('released', Lang.bind(this, this._onMultiPressReleased));
        this._tapGesture.connect('stopped', Lang.bind(this, this._onMultiPressStopped));
    },

    createBarWidget: function() {
        return null;
    },

    _onEnterNotify: function() {
        this._unqueueAutoHide();
        return false;
    },

    _onLeaveNotify: function() {
        this._queueAutoHide();
        return false;
    },

    _motionTimeout: function() {
        this._motionId = 0;
        this._visibleInternal = true;
        this._updateVisibility();
        if (this.barWidget && !this.barWidget.hover)
            this._queueAutoHide();
        return false;
    },

    _onMotion: function(widget, event) {
        if (this._motionId != 0)
            return false;

        let device = event.get_source_device();
        if (device.input_source == Gdk.InputSource.TOUCHSCREEN)
            return false;

        this._motionId = Mainloop.idle_add(Lang.bind(this, this._motionTimeout));
        return false;
    },

    _onMultiPressReleased: function() {
        this._tapGesture.set_state(Gtk.EventSequenceState.CLAIMED);
        this._visibleInternal = !this._visibleInternal;
        this._unqueueAutoHide();
        this._updateVisibility();
    },

    _onMultiPressStopped: function() {
        this._tapGesture.set_state(Gtk.EventSequenceState.DENIED);
    },

    _onPrevClicked: function() {
        this.preview.goPrev();
    },

    _onNextClicked: function() {
        this.preview.goNext();
    },

    _autoHide: function() {
        this._autoHideId = 0;
        this._visibleInternal = false;
        this._updateVisibility();
        return false;
    },

    _unqueueAutoHide: function() {
        if (this._autoHideId == 0)
            return;

        Mainloop.source_remove(this._autoHideId);
        this._autoHideId = 0;
    },

    _queueAutoHide: function() {
        this._unqueueAutoHide();
        this._autoHideId = Mainloop.timeout_add_seconds(_AUTO_HIDE_TIMEOUT, Lang.bind(this, this._autoHide));
    },

    _updateVisibility: function() {
        let currentPage = this.preview.page;
        let numPages = this.preview.numPages;

        if (!this._visible || !this._visibleInternal || !this.preview.hasPages) {
            if (this._barRevealer)
                this._barRevealer.reveal_child = false;
            this._prevRevealer.reveal_child = false;
            this._nextRevealer.reveal_child = false;
            return;
        }

        if (this._barRevealer)
            this._barRevealer.reveal_child = true;

        this._prevRevealer.reveal_child = currentPage > 0;
        this._nextRevealer.reveal_child = numPages > currentPage + 1;
    },

    show: function() {
        this._visible = true;
        this._visibleInternal = true;
        this._updateVisibility();
        this._queueAutoHide();
    },

    hide: function() {
        this._visible = false;
        this._visibleInternal = false;
        this._updateVisibility();
    },

    destroy: function() {
        if (this._barRevealer)
            this._barRevealer.destroy();
        this._prevRevealer.destroy();
        this._nextRevealer.destroy();
        this._tapGesture = null;
    }
});

var PreviewSearchbar = new Lang.Class({
    Name: 'PreviewSearchbar',
    Extends: Searchbar.Searchbar,

    _init: function(preview) {
        this.preview = preview;

        this.parent();

        this.connect('notify::search-mode-enabled', Lang.bind(this, function() {
            let action = this.preview.getAction('find');
            action.change_state(GLib.Variant.new('b', this.search_mode_enabled));
        }));
    },

    createSearchWidget: function() {
        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                halign: Gtk.Align.CENTER});
        box.get_style_context().add_class('linked');

        this.searchEntry = new Gtk.SearchEntry({ width_request: 500 });
        this.searchEntry.connect('activate', Lang.bind(this, function() {
            this.preview.activateResult();
        }));
        box.add(this.searchEntry);

        this._prev = new Gtk.Button({ action_name: 'view.find-prev' });
        this._prev.set_image(new Gtk.Image({ icon_name: 'go-up-symbolic',
                                             icon_size: Gtk.IconSize.MENU }));
        this._prev.set_tooltip_text(_("Find Previous"));
        box.add(this._prev);

        this._next = new Gtk.Button({ action_name: 'view.find-next' });
        this._next.set_image(new Gtk.Image({ icon_name: 'go-down-symbolic',
                                             icon_size: Gtk.IconSize.MENU }));
        this._next.set_tooltip_text(_("Find Next"));
        box.add(this._next);

        return box;
    },

    entryChanged: function() {
        this.preview.search(this.searchEntry.get_text());
    },

    reveal: function() {
        this.parent();

        if (!this.searchEntry.get_text()) {
            this.searchEntry.set_text(this.preview.lastSearch);
            this.searchEntry.select_region(0, -1);
        }

        this.preview.search(this.searchEntry.get_text());
    },

    conceal: function() {
        this.searchChangeBlocked = true;
        this.parent();
        this.searchChangeBlocked = false;
    }
});
