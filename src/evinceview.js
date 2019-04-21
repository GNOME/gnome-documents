/*
 * Copyright (c) 2011, 2015 Red Hat, Inc.
 *
 * Gnome Documents is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 2 of the License, or (at your
 * option) any later version.
 *
 * Gnome Documents is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Gnome Documents; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Author: Cosimo Cecchi <cosimoc@redhat.com>
 *
 */

const EvDocument = imports.gi.EvinceDocument;
const EvView = imports.gi.EvinceView;
const GdPrivate = imports.gi.GdPrivate;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const Documents = imports.documents;
const Places = imports.places;
const Presentation = imports.presentation;
const Preview = imports.preview;
const Utils = imports.utils;
const WindowMode = imports.windowMode;

var EvinceView = GObject.registerClass(
    class EvinceView extends Preview.Preview {

    _init(overlay, mainWindow) {
        this._model = null;
        this._jobFind = null;
        this._pageChanged = false;
        this._hasSelection = false;
        this._viewSelectionChanged = false;

        super._init(overlay, mainWindow);

        this.getAction('bookmark-page').enabled = false;
    }

    _copy() {
        this._evView.copy();
    }

    _zoomIn() {
        if (!this._model)
            return;
        this._model.set_sizing_mode(EvView.SizingMode.FREE);
        this._evView.zoom_in();
    }

    _zoomOut() {
        if (!this._model)
            return;
        this._model.set_sizing_mode(EvView.SizingMode.FREE);
        this._evView.zoom_out();
    }

    _rotateLeft() {
        let rotation = this._model.get_rotation();
        this._model.set_rotation(rotation - 90);
    }

    _rotateRight() {
        let rotation = this._model.get_rotation();
        this._model.set_rotation(rotation + 90);
    }

    findPrev() {
        this._evView.find_previous();
    }

    findNext() {
        this._evView.find_next();
    }

    _places() {
        let dialog = new Places.PlacesDialog(this._model, this._bookmarks);
        dialog.connect('response', Lang.bind(this, function(widget, response) {
            widget.destroy();
        }));
    }

    _findStateChanged(action) {
        let toolbar = this.toolbar;
        if (this.fullscreen)
            toolbar = this.getFullscreenToolbar().toolbar;

        if (action.state.get_boolean()) {
            toolbar.searchbar.reveal();
            this._evView.find_set_highlight_search(true);
        } else {
            toolbar.searchbar.conceal();
            this._evView.find_set_highlight_search(false);
        }
    }

    _bookmarkStateChanged(action) {
        let pageNumber = this._model.page;
        let bookmark = new GdPrivate.Bookmark({ page_number: pageNumber });

        if (action.state.get_boolean())
            this._bookmarks.add(bookmark);
        else
            this._bookmarks.remove(bookmark);
    }

    _presentStateChanged(action) {
        if (!this._model)
            return;

        if (action.state.get_boolean())
            this._promptPresentation();
        else
            this._hidePresentation();
    }

    _edit() {
        Application.modeController.setWindowMode(WindowMode.WindowMode.EDIT);
    }

    _print() {
        let doc = Application.documentManager.getActiveItem();
        if (doc)
            doc.print(this.mainWindow);
    }

    _scrollUp() {
        this._evView.scroll(Gtk.ScrollType.PAGE_BACKWARD, false);
    }

    _scrollDown() {
        this._evView.scroll(Gtk.ScrollType.PAGE_FORWARD, false);
    }

    createActions() {
        let actions = [
            { name: 'zoom-in',
              callback: Lang.bind(this, this._zoomIn),
              accels: ['<Primary>plus', '<Primary>equal'] },
            { name: 'zoom-out',
              callback: Lang.bind(this, this._zoomOut),
              accels: ['<Primary>minus'] },
            { name: 'copy',
              callback: Lang.bind(this, this._copy),
              accels: ['<Primary>c'] },
            { name: 'rotate-left',
              callback: Lang.bind(this, this._rotateLeft),
              accels: ['<Primary>Left'] },
            { name: 'rotate-right',
              callback: Lang.bind(this, this._rotateRight),
              accels: ['<Primary>Right'] },
            { name: 'find',
              callback: Utils.actionToggleCallback,
              state: GLib.Variant.new('b', false),
              stateChanged: Lang.bind(this, this._findStateChanged),
              accels: ['<Primary>f'] },
            { name: 'find-prev',
              callback: Lang.bind(this, this.findPrev),
              accels: ['<Shift><Primary>g'] },
            { name: 'find-next',
              callback: Lang.bind(this, this.findNext),
              accels: ['<Primary>g'] },
            { name: 'places',
              callback: Lang.bind(this, this._places),
              accels: ['<Primary>b'] },
            { name: 'bookmark-page',
              callback: Utils.actionToggleCallback,
              state: GLib.Variant.new('b', false),
              stateChanged: Lang.bind(this, this._bookmarkStateChanged),
              accels: ['<Primary>d'] },
            { name: 'edit-current',
              callback: Lang.bind(this, this._edit) },
            { name: 'print-current',
              callback: Lang.bind(this, this._print),
              accels: ['<Primary>p'] },
            { name: 'scroll-up',
              callback: Lang.bind(this, this._scrollUp),
              accels: ['Page_Up'] },
            { name: 'scroll-down',
              callback: Lang.bind(this, this._scrollDown),
              accels: ['Page_Down'] }
        ];

        actions.push({ name: 'present-current',
                       callback: Utils.actionToggleCallback,
                       state: GLib.Variant.new('b', false),
                       stateChanged: Lang.bind(this, this._presentStateChanged),
                       accels: ['F5'] });

        return actions;
    }

    createNavControls() {
        return new EvinceViewNavControls(this, this.overlay);
    }

    createToolbar() {
        return new EvinceViewToolbar(this);
    }

    createView() {
        let sw = new Gtk.ScrolledWindow({ hexpand: true,
                                          vexpand: true });
        sw.get_style_context().add_class('documents-scrolledwin');
        sw.get_hscrollbar().connect('button-press-event', Lang.bind(this, this._onScrollbarClick));
        sw.get_vscrollbar().connect('button-press-event', Lang.bind(this, this._onScrollbarClick));
        sw.get_hadjustment().connect('value-changed', Lang.bind(this, this._onAdjustmentChanged));
        sw.get_vadjustment().connect('value-changed', Lang.bind(this, this._onAdjustmentChanged));

        this._evView = EvView.View.new();
        sw.add(this._evView);
        this._evView.show();

        this._evView.connect('notify::can-zoom-in', Lang.bind(this,
            this._onCanZoomInChanged));
        this._evView.connect('notify::can-zoom-out', Lang.bind(this,
            this._onCanZoomOutChanged));
        this._evView.connect('button-press-event', Lang.bind(this,
            this._onButtonPressEvent));
        this._evView.connect('button-release-event', Lang.bind(this,
            this._onButtonReleaseEvent));
        this._evView.connect('selection-changed', Lang.bind(this,
            this._onViewSelectionChanged));
        this._evView.connect('external-link', Lang.bind(this,
            this._handleExternalLink));

        return sw;
    }

    onLoadStarted(manager, doc) {
        super.onLoadStarted(manager, doc);

        this.getAction('bookmark-page').enabled = false;
        this.getAction('find').enabled = false;
        this.getAction('gear-menu').enabled = false;
        this.getAction('places').enabled = false;
    }

    onLoadFinished(manager, doc, docModel) {
        this.controlsVisible = false;
        this._lastSearch = '';
        this._model = docModel;

        super.onLoadFinished(manager, doc, docModel);

        docModel.set_sizing_mode(EvView.SizingMode.AUTOMATIC);

        docModel.set_continuous(false);
        docModel.set_page_layout(EvView.PageLayout.AUTOMATIC);

        this._model.connect('page-changed', Lang.bind(this, this._onPageChanged));

        this._metadata = this._loadMetadata();
        if (this._metadata)
            this._bookmarks = new GdPrivate.Bookmarks({ metadata: this._metadata });

        this._onPageChanged();

        this.getAction('copy').enabled = false;
        this.getAction('edit-current').enabled = doc.canEdit();
        this.getAction('print-current').enabled = doc.canPrint(docModel);
        let presentCurrent = this.getAction('present-current');
        if (presentCurrent)
            presentCurrent.enabled = true;

        let hasMultiplePages = (this.numPages > 1);
        this.getAction('bookmark-page').enabled = hasMultiplePages && this._bookmarks;
        this.getAction('places').enabled = hasMultiplePages;

        this._enableSearch();
        this.getAction('gear-menu').enabled = true;

        this._evView.set_model(this._model);
        this.navControls.setModel(this._model);
        this.toolbar.updateTitle();

        this.set_visible_child_full('view', Gtk.StackTransitionType.NONE);
        this.grab_focus();
    }

    onLoadError(manager, doc, message, exception) {
        this._controlsVisible = true;
        this._syncControlsVisible();

        super.onLoadError(manager, doc, message, exception);
    }

    _enableSearch() {
        let canFind = true;

        try {
            // This is a hack to find out if evDoc implements the
            // EvDocument.DocumentFind interface or not. We don't expect
            // the following invocation to work.
            let evDoc = this._model.get_document();
            evDoc.find_text();
        } catch (e) {
            if (e instanceof TypeError) {
                canFind = false;
            }
        }

        this.getAction('find').enabled = (this.hasPages && canFind);
    }

    _onPageChanged() {
        let pageNumber = this._model.page;
        this._pageChanged = true;
        if (this._metadata)
            this._metadata.set_int('page', pageNumber);

        if (!this._bookmarks)
            return;

        let bookmark = new GdPrivate.Bookmark({ page_number: pageNumber });
        let hasBookmark = (this._bookmarks.find_bookmark(bookmark) != null);

        this.getAction('bookmark-page').change_state(GLib.Variant.new('b', hasBookmark));
    }

    _hidePresentation() {
        if (this._presentation) {
            this._presentation.close();
            this._presentation = null;
        }

        this.getAction('present-current').change_state(GLib.Variant.new('b', false));
    }

    _showPresentation(output) {
        this._presentation = new Presentation.PresentationWindow(this._model);
        this._presentation.connect('destroy', Lang.bind(this, this._hidePresentation));
        if (output)
            this._presentation.setOutput(output);
    }

    _promptPresentation() {
        let outputs = new Presentation.PresentationOutputs();
        if (outputs.list.length < 2) {
            this._showPresentation();
        } else {
            let chooser = new Presentation.PresentationOutputChooser(outputs);
            chooser.connect('output-activated', Lang.bind(this,
                function(chooser, output) {
                    if (output) {
                        this._showPresentation(output);
                    } else {
                        this._hidePresentation();
                    }
                }));

        }
    }

    _onViewSelectionChanged() {
        let hasSelection = this._evView.get_has_selection();
        this.getAction('copy').enabled = hasSelection;

        if (!hasSelection &&
            hasSelection == this._hasSelection) {
            this._viewSelectionChanged = false;
            return;
        }

        this._hasSelection = hasSelection;
        this._viewSelectionChanged = true;
        if (!hasSelection)
            this.cancelControlsFlip();
    }

    _uriRewrite(uri) {
        if (uri.substring(0, 3) != 'www.') {
            /* Prepending "http://" when the url is a webpage (starts with
             * "www.").
             */
            uri = 'http://' + uri;
        } else {
            /* Or treating as a file, otherwise.
             * http://en.wikipedia.org/wiki/File_URI_scheme
             */
            let doc = Application.documentManager.getActiveItem();
            let file = Gio.file_new_for_uri(doc.uri);
            let parent = file.get_parent();

            if (parent)
                uri = parent.get_uri() + uri;
            else
                uri = 'file:///' + uri;
        }

        return uri;
    }

    _launchExternalUri(widget, action) {
        let uri = action.get_uri();
        let screen = widget.get_screen();
        let context = screen.get_display().get_app_launch_context();

        context.set_screen(screen);
        context.set_timestamp(Gtk.get_current_event_time());

        if (uri.indexOf('://') == -1 && uri.substring(0, 6) != 'mailto:')
            /* We are only interested in treat URLs (ignoring URN and Mailto
             * schemes), which have this syntax scheme:
             * scheme://domain:port/path?query_string#fragment_id
             *
             * So, if the url is bad formed (doesn't contain "://"), we need to
             * rewrite it.
             *
             * An example of URL, URN and Mailto schemes can be found in:
             * http://en.wikipedia.org/wiki/URI_scheme#Examples
             */
            uri = this._uriRewrite(uri);

        try {
            Gio.AppInfo.launch_default_for_uri(uri, context);
        } catch (e) {
            logError(e, 'Unable to open external link');
        }
    }

    _handleExternalLink(widget, action) {
        if (action.type == EvDocument.LinkActionType.EXTERNAL_URI)
            this._launchExternalUri(widget, action);
    }

    _onCanZoomInChanged() {
        this.getAction('zoom-in').enabled = this._evView.can_zoom_in;
    }

    _onCanZoomOutChanged() {
        this.getAction('zoom-out').enabled = this._evView.can_zoom_out;
    }

    _onButtonPressEvent(widget, event) {
        let button = event.get_button()[1];

        if (button == 3) {
            let time = event.get_time();
            this.contextMenu.popup(null, null, null, button, time);
            return true;
        }

        this._viewSelectionChanged = false;
        return false;
    }

    _onButtonReleaseEvent(widget, event) {
        let button = event.get_button()[1];
        let clickCount = event.get_click_count()[1];

        if (button == 1
            && clickCount == 1
            && !this._viewSelectionChanged)
            this.queueControlsFlip();
        else
            this.cancelControlsFlip();

        this._viewSelectionChanged = false;

        return false;
    }

    _onScrollbarClick() {
        this.controlsVisible = false;
        return false;
    }

    _onAdjustmentChanged() {
        if (!this._pageChanged)
            this.controlsVisible = false;
        this._pageChanged = false;
    }

    search(str) {
        this._evView.find_search_changed();

        if (!this._model)
            return;

        super.search(str);

        if (this._jobFind) {
            if (!this._jobFind.is_finished())
                this._jobFind.cancel();
            this._jobFind = null;
        }

        if (!str) {
            this._evView.queue_draw();
            return;
        }

        let evDoc = this._model.get_document();
        this._jobFind = EvView.JobFind.new(evDoc, this._model.get_page(), evDoc.get_n_pages(),
                                           str, false);
        this._jobFind.connect('updated', Lang.bind(this, this._onSearchJobUpdated));

        this._jobFind.scheduler_push_job(EvView.JobPriority.PRIORITY_NONE);
    }

    _onSearchJobUpdated(job, page) {
        // FIXME: ev_job_find_get_results() returns a GList **
        // and thus is not introspectable
        GdPrivate.ev_view_find_changed(this._evView, job, page);

        let hasResults = job.has_results();
        this.getAction('find-prev').enabled = hasResults;
        this.getAction('find-next').enabled = hasResults;
    }

    _loadMetadata() {
        let evDoc = this._model.get_document();
        let file = Gio.File.new_for_uri(evDoc.get_uri());
        if (!GdPrivate.is_metadata_supported_for_file(file))
            return null;

        let metadata = new GdPrivate.Metadata({ file: file });

        let [res, val] = metadata.get_int('page');
        if (res)
            this._model.set_page(val);

        return metadata;
    }

    goPrev() {
        this._evView.previous_page();
    }

    goNext() {
        this._evView.next_page();
    }

    get hasPages() {
        return this._model ? (this._model.document.get_n_pages() > 0) : false;
    }

    get page() {
        return this._model ? this._model.page : 0;
    }

    get numPages() {
        return this._model ? this._model.document.get_n_pages() : 0;
    }

    get canFullscreen() {
        return true;
    }

    set nightMode(v) {
        if (this._model)
            this._model.set_inverted_colors(v);
    }
});

const EvinceViewNavControls = GObject.registerClass(
    class EvinceViewNavControls extends Preview.PreviewNavControls {

    createBarWidget() {
        let barWidget = new GdPrivate.NavBar();

        let buttonArea = barWidget.get_button_area();

        let button = new Gtk.Button({ action_name: 'view.places',
                                      image: new Gtk.Image({ icon_name: 'view-list-symbolic',
                                                             pixel_size: 16 }),
                                      valign: Gtk.Align.CENTER,
                                      tooltip_text: _("Bookmarks")
                                    });
        buttonArea.pack_start(button, false, false, 0);

        button = new Gtk.ToggleButton({ action_name: 'view.bookmark-page',
                                        image: new Gtk.Image({ icon_name: 'bookmark-new-symbolic',
                                                               pixel_size: 16 }),
                                        valign: Gtk.Align.CENTER,
                                        tooltip_text: _("Bookmark this page")
                                      });
        buttonArea.pack_start(button, false, false, 0);

        return barWidget;
    }

    setModel(model) {
        this.barWidget.document_model = model;
        model.connect('page-changed', Lang.bind(this, this._updateVisibility));
    }
});

const EvinceViewToolbar = GObject.registerClass(
    class EvinceViewToolbar extends Preview.PreviewToolbar {

    _init(preview) {
        super._init(preview);

        this._handleEvent = false;

        this.addSearchButton('view.find');
    }
});
