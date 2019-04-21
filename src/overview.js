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

const Cairo = imports.gi.cairo;
const Gd = imports.gi.Gd;
const Gdk = imports.gi.Gdk;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const ErrorBox = imports.errorBox;
const MainToolbar = imports.mainToolbar;
const Search = imports.search;
const Searchbar = imports.searchbar;
const Selections = imports.selections;
const WindowMode = imports.windowMode;
const Utils = imports.utils;

const _ICON_SIZE = 32;

function getController(windowMode) {
    let offsetController;
    let trackerController;

    switch (windowMode) {
    case WindowMode.WindowMode.COLLECTIONS:
        offsetController = Application.offsetCollectionsController;
        trackerController = Application.trackerCollectionsController;
        break;
    case WindowMode.WindowMode.DOCUMENTS:
        offsetController = Application.offsetDocumentsController;
        trackerController = Application.trackerDocumentsController;
        break;
    case WindowMode.WindowMode.SEARCH:
        offsetController = Application.offsetSearchController;
        trackerController = Application.trackerSearchController;
        break;
    default:
        throw(new Error('Not handled'));
        break;
    }

    return [ offsetController, trackerController ];
}

const _RESET_COUNT_TIMEOUT = 500; // msecs

const ViewModel = GObject.registerClass(
    class ViewModel extends Gtk.ListStore {

    _init(windowMode) {
        super._init();
        this.set_column_types(
            [ GObject.TYPE_STRING,
              GObject.TYPE_STRING,
              GObject.TYPE_STRING,
              GObject.TYPE_STRING,
              Cairo.Surface,
              GObject.TYPE_LONG,
              GObject.TYPE_BOOLEAN,
              GObject.TYPE_UINT ]);

        this._infoUpdatedIds = {};
        this._resetCountId = 0;

        this._mode = windowMode;
        this._rowRefKey = "row-ref-" + this._mode;

        Application.documentManager.connect('item-added',
            Lang.bind(this, this._onItemAdded));
        Application.documentManager.connect('item-removed',
            Lang.bind(this, this._onItemRemoved));

        [ this._offsetController, this._trackerController ] = getController(this._mode);
        this._trackerController.connect('query-status-changed', Lang.bind(this,
            function(o, status) {
                if (!status)
                    return;
                this._clear();
            }));

        // populate with the initial items
        let items = Application.documentManager.getItems();
        for (let idx in items) {
            this._onItemAdded(Application.documentManager, items[idx]);
        }
    }

    _clear() {
        let items = Application.documentManager.getItems();
        for (let idx in items) {
            let doc = items[idx];
            doc.rowRefs[this._rowRefKey] = null;
        }

        this.clear();
    }

    _addItem(doc) {
        // Update the count so that OffsetController has the correct
        // values. Otherwise things like loading more items and "No
        // Results" page will not work correctly.
        this._resetCount();

        let iter = this.append();
        this.set(iter,
            [ 0, 1, 2, 3, 4, 5 ],
            [ doc.id, doc.uri, doc.name,
              doc.author, doc.surface, doc.mtime ]);

        let treePath = this.get_path(iter);
        let treeRowRef = Gtk.TreeRowReference.new(this, treePath);
        doc.rowRefs[this._rowRefKey] = treeRowRef;
    }

    _removeItem(doc) {
        // Update the count so that OffsetController has the correct
        // values. Otherwise things like loading more items and "No
        // Results" page will not work correctly.
        this._resetCount();

        this.foreach(Lang.bind(this,
            function(model, path, iter) {
                let id = model.get_value(iter, Gd.MainColumns.ID);

                if (id == doc.id) {
                    this.remove(iter);
                    return true;
                }

                return false;
            }));

        doc.rowRefs[this._rowRefKey] = null;
    }

    _onInfoUpdated(doc) {
        let activeCollection = Application.documentManager.getActiveCollection();
        let treeRowRef = doc.rowRefs[this._rowRefKey];

        if (this._mode == WindowMode.WindowMode.COLLECTIONS) {
            if (!doc.collection && treeRowRef && !activeCollection) {
                ;
            } else if (doc.collection && !treeRowRef && !activeCollection) {
                this._addItem(doc);
            }
        } else if (this._mode == WindowMode.WindowMode.DOCUMENTS) {
            if (doc.collection && treeRowRef) {
                ;
            } else if (!doc.collection && !treeRowRef) {
                this._addItem(doc);
            }
        }

        treeRowRef = doc.rowRefs[this._rowRefKey];
        if (treeRowRef) {
            let objectPath = treeRowRef.get_path();
            if (!objectPath)
                return;

            let objectIter = this.get_iter(objectPath)[1];
            if (objectIter)
                this.set(objectIter,
                    [ 0, 1, 2, 3, 4, 5 ],
                    [ doc.id, doc.uri, doc.name,
                      doc.author, doc.surface, doc.mtime ]);
        }
    }

    _onItemAdded(source, doc) {
        if (doc.rowRefs[this._rowRefKey])
            return;

        let infoUpdatedId = this._infoUpdatedIds[doc.id];
        if (infoUpdatedId) {
            doc.disconnect(infoUpdatedId);
            delete this._infoUpdatedIds[doc.id];
        }

        let activeCollection = Application.documentManager.getActiveCollection();
        let windowMode = Application.modeController.getWindowMode();

        if (!activeCollection || this._mode != windowMode) {
            if (this._mode == WindowMode.WindowMode.COLLECTIONS && !doc.collection
                || this._mode == WindowMode.WindowMode.DOCUMENTS && doc.collection) {
                this._infoUpdatedIds[doc.id] = doc.connect('info-updated', Lang.bind(this, this._onInfoUpdated));
                return;
            }
        }

        this._addItem(doc);
        this._infoUpdatedIds[doc.id] = doc.connect('info-updated', Lang.bind(this, this._onInfoUpdated));
    }

    _onItemRemoved(source, doc) {
        this._removeItem(doc);
        doc.disconnect(this._infoUpdatedIds[doc.id]);
        delete this._infoUpdatedIds[doc.id];
    }

    _resetCount() {
        if (this._resetCountId == 0) {
            this._resetCountId = Mainloop.timeout_add(_RESET_COUNT_TIMEOUT, Lang.bind(this,
                function() {
                    this._resetCountId = 0;
                    this._offsetController.resetItemCount();
                    return false;
                }));
        }
    }
});

const EmptyResultsBox = GObject.registerClass(
    class EmptyResultsBox extends Gtk.Grid {

    _init(mode) {
        this._mode = mode;
        super._init({ orientation: Gtk.Orientation.VERTICAL,
                      row_spacing: 12,
                      hexpand: true,
                      vexpand: true,
                      halign: Gtk.Align.CENTER,
                      valign: Gtk.Align.CENTER });
        this.get_style_context().add_class('dim-label');

        this._addImage();
        this._addPrimaryLabel();
        this._addSecondaryLabel();

        this.show_all();
    }

    _addImage() {
        let iconName;
        if (this._mode == WindowMode.WindowMode.SEARCH)
            iconName = 'system-search-symbolic';
        else if (this._mode == WindowMode.WindowMode.COLLECTIONS)
            iconName = 'emblem-documents-symbolic';
        else
            iconName = 'x-office-document-symbolic';

        this.add(new Gtk.Image({ pixel_size: 128, icon_name: iconName, margin_bottom: 9 }));
    }

    _addPrimaryLabel() {
        let text;
        if (this._mode == WindowMode.WindowMode.COLLECTIONS)
            text = _("No collections found");
        else
            text = _("No documents found");

        this.add(new Gtk.Label({ label: '<b><span size="large">' + text + '</span></b>',
                                 use_markup: true,
                                 margin_top: 9 }));
    }

    _addSecondaryLabel() {
        if (this._mode == WindowMode.WindowMode.SEARCH) {
            this.add(new Gtk.Label({ label: _("Try a different search") }));
            return;
        }

        if (this._mode == WindowMode.WindowMode.COLLECTIONS) {
            this.add(new Gtk.Label({ label: _("You can create collections from the Documents view") }));
            return;
        }

        let documentsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
        let detailsStr = _("Documents from your <a href=\"system-settings\">Online Accounts</a> and " +
                           "<a href=\"file://%s\">Documents folder</a> will appear here.").format(documentsPath);
        let details = new Gtk.Label({ label: detailsStr,
                                      use_markup: true });
        this.add(details);

        details.connect('activate-link', Lang.bind(this,
            function(label, uri) {
                if (uri != 'system-settings')
                    return false;

                try {
                    let app = Gio.AppInfo.create_from_commandline(
                        'gnome-control-center online-accounts', null, 0);

                    let screen = this.get_screen();
                    let display = screen ? screen.get_display() : Gdk.Display.get_default();
                    let ctx = display.get_app_launch_context();

                    if (screen)
                        ctx.set_screen(screen);

                    app.launch([], ctx);
                } catch(e) {
                    logError(e, 'Unable to launch gnome-control-center');
                }

                return true;
            }));
    }
});

const OverviewSearchbar = GObject.registerClass(
    class OverviewSearchbar extends Searchbar.Searchbar {

    _init(view) {
        this._view = view;

        super._init();

        let sourcesId = Application.sourceManager.connect('active-changed',
            Lang.bind(this, this._onActiveSourceChanged));
        let searchTypeId = Application.searchTypeManager.connect('active-changed',
            Lang.bind(this, this._onActiveTypeChanged));
        let searchMatchId = Application.searchMatchManager.connect('active-changed',
            Lang.bind(this, this._onActiveMatchChanged));
        let collectionId = Application.documentManager.connect('active-collection-changed',
            Lang.bind(this, this._onActiveCollectionChanged));

        this._onActiveSourceChanged();
        this._onActiveTypeChanged();
        this._onActiveMatchChanged();

        let searchAction = this._view.getAction('search');
        this.connect('notify::search-mode-enabled', Lang.bind(this, function() {
            let searchEnabled = this.search_mode_enabled;
            searchAction.change_state(GLib.Variant.new('b', searchEnabled));
        }));

        // connect to the search action state for visibility
        let searchStateId = searchAction.connect('notify::state', Lang.bind(this, this._onActionStateChanged));
        this._onActionStateChanged(searchAction);

        this.searchEntry.set_text(Application.searchController.getString());
        this.connect('destroy', Lang.bind(this,
            function() {
                Application.sourceManager.disconnect(sourcesId);
                Application.searchTypeManager.disconnect(searchTypeId);
                Application.searchMatchManager.disconnect(searchMatchId);
                Application.documentManager.disconnect(collectionId);

                searchAction.disconnect(searchStateId);
            }));
    }

    createSearchWidget() {
        // create the search entry
        this.searchEntry = new Gd.TaggedEntry({ width_request: 500 });
        this.searchEntry.connect('tag-clicked',
            Lang.bind(this, this._onTagClicked));
        this.searchEntry.connect('tag-button-clicked',
            Lang.bind(this, this._onTagButtonClicked));

        this._sourceTag = new Gd.TaggedEntryTag();
        this._typeTag = new Gd.TaggedEntryTag();
        this._matchTag = new Gd.TaggedEntryTag();

        // connect to search string changes in the controller
        this._searchChangedId = Application.searchController.connect('search-string-changed',
            Lang.bind(this, this._onSearchStringChanged));

        this.searchEntry.connect('destroy', Lang.bind(this,
            function() {
                Application.searchController.disconnect(this._searchChangedId);
            }));

        // create the dropdown button
        let dropdown = new Searchbar.Dropdown();
        this._dropdownButton = new Gtk.MenuButton({ popover: dropdown });

        let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                halign: Gtk.Align.CENTER });
        box.get_style_context().add_class('linked');

        box.add(this.searchEntry);
        box.add(this._dropdownButton);
        box.show_all();

        return box;
    }

    entryChanged() {
        let currentText = this.searchEntry.get_text();

        Application.searchController.disconnect(this._searchChangedId);
        Application.searchController.setString(currentText);

        // connect to search string changes in the controller
        this._searchChangedId = Application.searchController.connect('search-string-changed',
            Lang.bind(this, this._onSearchStringChanged));
    }

    _onSearchStringChanged(controller, string) {
        this.searchEntry.set_text(string);
    }

    _onActiveCollectionChanged(manager, collection) {
        if (!collection)
            return;

        let searchType = Application.searchTypeManager.getActiveItem();

        if (Application.searchController.getString() != '' ||
            searchType.id != 'all') {
            Application.searchTypeManager.setActiveItemById('all');
            this.searchEntry.set_text('');
        }
    }

    _onActiveChangedCommon(id, manager, tag) {
        let item = manager.getActiveItem();

        if (item.id == 'all') {
            this.searchEntry.remove_tag(tag);
        } else {
            tag.set_label(item.name);
            this.searchEntry.add_tag(tag);
        }

        this.searchEntry.grab_focus_without_selecting();
    }

    _onActiveSourceChanged() {
        this._onActiveChangedCommon('source', Application.sourceManager, this._sourceTag);
    }

    _onActiveTypeChanged() {
        this._onActiveChangedCommon('type', Application.searchTypeManager, this._typeTag);
    }

    _onActiveMatchChanged() {
        this._onActiveChangedCommon('match', Application.searchMatchManager, this._matchTag);
    }

    _onTagButtonClicked(entry, tag) {
        let manager = null;

        if (tag == this._matchTag) {
            manager = Application.searchMatchManager;
        } else if (tag == this._typeTag) {
            manager = Application.searchTypeManager;
        } else if (tag == this._sourceTag) {
            manager = Application.sourceManager;
        }

        if (manager) {
            manager.setActiveItemById('all');
        }
    }

    _onTagClicked() {
        this._dropdownButton.set_active(true);
    }

    _onActionStateChanged(action) {
        if (action.state.get_boolean())
            this.reveal();
        else
            this.conceal();
    }

    conceal() {
        this._dropdownButton.set_active(false);

        Application.searchTypeManager.setActiveItemById('all');
        Application.searchMatchManager.setActiveItemById('all');
        Application.sourceManager.setActiveItemById('all');

        super.conceal();
    }
});

const OverviewToolbar = GObject.registerClass(
    class OverviewToolbar extends MainToolbar.MainToolbar {

    _init(view) {
        this._collBackButton = null;
        this._collectionId = 0;
        this._selectionChangedId = 0;
        this._viewMenuButton = null;
        this._viewSettingsId = 0;
        this._activeCollection = null;
        this._infoUpdatedId = 0;
        this._countChangedId = 0;

        this._view = view;

        super._init();

        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Documents/ui/selection-menu.ui');
        let selectionMenu = builder.get_object('selection-menu');
        this._selectionMenu = new Gtk.MenuButton({ menu_model: selectionMenu });
        this._selectionMenu.get_style_context().add_class('selection-menu');

        this._stackSwitcher = new Gtk.StackSwitcher({ no_show_all: true,
                                                      stack: this._view.stack });
        this._stackSwitcher.show();

        // setup listeners to mode changes that affect the toolbar layout
        let selectionModeAction = this._view.getAction('selection-mode');
        let selectionModeStateId = selectionModeAction.connect('notify::state',
            Lang.bind(this, this._resetToolbarMode));
        this._resetToolbarMode();

        this._activeCollection = Application.documentManager.getActiveCollection();
        if (this._activeCollection)
            this._activeCollection.connect('info-updated', Lang.bind(this, this._setToolbarTitle));

        this.connect('destroy', Lang.bind(this,
            function() {
                if (this._infoUpdatedId != 0)
                    this._activeCollection.disconnect(this._infoUpdatedId);

                this._clearStateData();
                selectionModeAction.disconnect(selectionModeStateId);
            }));
    }

    _addViewMenuButton() {
        let builder = new Gtk.Builder();
        builder.add_from_resource('/org/gnome/Documents/ui/view-menu.ui');
        let viewMenu = builder.get_object('viewMenu');

        // Translators: this is the menu to change view settings
        this._viewMenuButton = new Gtk.MenuButton({ tooltip_text: _("View Menu"),
                                                    popover: viewMenu });
        this.toolbar.pack_end(this._viewMenuButton);

        this._viewSettingsId = Application.settings.connect('changed::view-as',
            Lang.bind(this, this._updateViewMenuButton));
        this._updateViewMenuButton();
    }

    _updateViewMenuButton() {
        let viewType = Application.settings.get_enum('view-as');
        let iconName = viewType == Gd.MainViewType.ICON ? 'view-grid-symbolic' : 'view-list-symbolic';
        this._viewMenuButton.image = new Gtk.Image({ icon_name: iconName, pixel_size: 16 })
    }

    _setToolbarTitle() {
        let selectionMode = this._view.getAction('selection-mode').state.get_boolean();
        let activeCollection = Application.documentManager.getActiveCollection();
        let primary = null;

        if (!selectionMode) {
            if (activeCollection)
                primary = activeCollection.name;
        } else {
            let length = Application.selectionController.getSelection().length;
            let label = null;

            if (length == 0)
                label = _("Click on items to select them");
            else
                label = Gettext.ngettext("%d selected",
                                         "%d selected",
                                         length).format(length);

            if (activeCollection)
                primary = ("<b>%s</b>  (%s)").format(activeCollection.name, label);
            else
                primary = label;
        }

        if (selectionMode) {
            if (primary) {
                this._selectionMenu.set_label(primary);
                this._selectionMenu.get_child().use_markup = true;
            }
        } else {
            this.toolbar.set_title(primary);
        }
    }

    _populateForSelectionMode() {
        this.toolbar.get_style_context().add_class('selection-mode');
        this.toolbar.set_custom_title(this._selectionMenu);

        let selectionButton = new Gtk.Button({ label: _("Cancel"),
                                               action_name: 'view.selection-mode' });
        this.toolbar.pack_end(selectionButton);

        // connect to selection changes while in this mode
        this._selectionChangedId =
            Application.selectionController.connect('selection-changed',
                                               Lang.bind(this, this._setToolbarTitle));

        this.addSearchButton('view.search');
    }

    _checkCollectionWidgets() {
        let customTitle;
        let item = Application.documentManager.getActiveCollection();

        if (item) {
            customTitle = null;
            if (!this._collBackButton) {
                this._collBackButton = this.addBackButton();
                this.toolbar.child_set_property(this._collBackButton, "position", 0);
                this._collBackButton.show();
            }
        } else {
            customTitle = this._stackSwitcher;
            if (this._collBackButton) {
                this._collBackButton.destroy();
                this._collBackButton = null;
            }
        }

        this.toolbar.set_custom_title(customTitle);
    }

    _onActiveCollectionChanged(manager, activeCollection) {
        if (activeCollection) {
            this._infoUpdatedId = activeCollection.connect('info-updated', Lang.bind(this, this._setToolbarTitle));
        } else {
            if (this._infoUpdatedId != 0) {
                this._activeCollection.disconnect(this._infoUpdatedId);
                this._infoUpdatedId = 0;
            }
        }
        this._activeCollection = activeCollection;
        this._checkCollectionWidgets();
        this._setToolbarTitle();
    }

    _populateForOverview() {
        this.toolbar.set_show_close_button(true);
        this.toolbar.set_custom_title(this._stackSwitcher);
        this._checkCollectionWidgets();

        this.addSearchButton('view.search');
        this.addMenuButton();

        let selectionButton = new Gtk.Button({ image: new Gtk.Image ({ icon_name: 'object-select-symbolic' }),
                                               tooltip_text: _("Select Items"),
                                               action_name: 'view.selection-mode' });
        this.toolbar.pack_end(selectionButton);

        this._addViewMenuButton();

        // connect to active collection changes while in this mode
        this._collectionId =
            Application.documentManager.connect('active-collection-changed',
                                             Lang.bind(this, this._onActiveCollectionChanged));
    }

    _clearStateData() {
        this._collBackButton = null;
        this._viewMenuButton = null;
        this.toolbar.set_custom_title(null);

        if (this._countChangedId != 0) {
            Application.offsetDocumentsController.disconnect(this._countChangedId);
            this._countChangedId = 0;
        }

        if (this._collectionId != 0) {
            Application.documentManager.disconnect(this._collectionId);
            this._collectionId = 0;
        }

        if (this._selectionChangedId != 0) {
            Application.selectionController.disconnect(this._selectionChangedId);
            this._selectionChangedId = 0;
        }

        if (this._viewSettingsId != 0) {
            Application.settings.disconnect(this._viewSettingsId);
            this._viewSettingsId = 0;
        }
    }

    _clearToolbar() {
        this._clearStateData();
        this.toolbar.set_show_close_button(false);

        this.toolbar.get_style_context().remove_class('selection-mode');
        let children = this.toolbar.get_children();
        children.forEach(function(child) { child.destroy(); });
    }

    _resetToolbarMode() {
        this._clearToolbar();

        let selectionMode = this._view.getAction('selection-mode').state.get_boolean();
        if (selectionMode)
            this._populateForSelectionMode();
        else
            this._populateForOverview();

        this._setToolbarTitle();
        this.toolbar.show_all();

        this._countChangedId = Application.offsetDocumentsController.connect('item-count-changed', Lang.bind(this,
            function(controller, count) {
                this.toolbar.foreach(Lang.bind(this,
                    function(child) {
                        child.set_sensitive(count != 0);
                    }));
            }));

        if (Application.searchController.getString() != '')
            this._view.getAction('search').change_state(GLib.Variant.new('b', true));
    }

    createSearchbar() {
        return new OverviewSearchbar(this._view);
    }
});

const ViewContainer = GObject.registerClass(
    class ViewContainer extends Gtk.Stack {

    _init(overview, windowMode) {
        this._edgeHitId = 0;
        this._mode = windowMode;

        this._model = new ViewModel(this._mode);

        super._init({ homogeneous: true,
                      transition_type: Gtk.StackTransitionType.CROSSFADE });

        this.view = new Gd.MainView({ shadow_type: Gtk.ShadowType.NONE });
        this.add_named(this.view, 'view');

        this._noResults = new EmptyResultsBox(this._mode);
        this.add_named(this._noResults, 'no-results');

        this._errorBox = new ErrorBox.ErrorBox();
        this.add_named(this._errorBox, 'error');

        this._spinner = new Gtk.Spinner({ width_request: _ICON_SIZE,
                                          height_request: _ICON_SIZE,
                                          halign: Gtk.Align.CENTER,
                                          valign: Gtk.Align.CENTER });
        this.add_named(this._spinner, 'spinner');

        this.show_all();
        this.set_visible_child_full('view', Gtk.StackTransitionType.NONE);

        this.view.connect('item-activated',
                          Lang.bind(this, this._onItemActivated));
        this.view.connect('selection-mode-request',
                          Lang.bind(this, this._onSelectionModeRequest));
        this.view.connect('view-selection-changed',
                          Lang.bind(this, this._onViewSelectionChanged));
        this.view.connect('notify::view-type',
                          Lang.bind(this, this._onViewTypeChanged));

        this._selectionModeAction = overview.getAction('selection-mode');
        this._selectionModeAction.connect('notify::state', Lang.bind(this, this._onSelectionModeChanged));
        this._onSelectionModeChanged();

        Application.modeController.connect('window-mode-changed',
            Lang.bind(this, this._onWindowModeChanged));
        this._onWindowModeChanged();

        [ this._offsetController, this._trackerController ] = getController(this._mode);

        this._offsetController.connect('item-count-changed', Lang.bind(this,
            function(controller, count) {
                if (count == 0)
                    this.set_visible_child_name('no-results');
                else
                    this.set_visible_child_name('view');
            }));

        this._trackerController.connect('query-error',
            Lang.bind(this, this._onQueryError));
        this._trackerController.connect('query-status-changed',
            Lang.bind(this, this._onQueryStatusChanged));
        // ensure the tracker controller is started
        this._trackerController.start();

        // this will create the model if we're done querying
        this._onQueryStatusChanged();
    }

    _onViewTypeChanged() {
        if (this.view.view_type == Gd.MainViewType.LIST)
            this._addListRenderers();
    }

    _getFirstDocument() {
        let doc = null;

        let [success, iter] = this._model.get_iter_first();
        if (success) {
            let id = this._model.get_value(iter, Gd.MainColumns.ID);
            doc = Application.documentManager.getItemById(id);
        }

        return doc;
    }

    _addListRenderers() {
        let listWidget = this.view.get_generic_view();

        let typeRenderer =
            new Gd.StyledTextRenderer({ xpad: 16 });
        typeRenderer.add_class('dim-label');
        listWidget.add_renderer(typeRenderer, Lang.bind(this,
            function(col, cell, model, iter) {
                let id = model.get_value(iter, Gd.MainColumns.ID);
                let doc = Application.documentManager.getItemById(id);

                typeRenderer.text = doc.typeDescription;
            }));

        let whereRenderer =
            new Gd.StyledTextRenderer({ xpad: 16 });
        whereRenderer.add_class('dim-label');
        listWidget.add_renderer(whereRenderer, Lang.bind(this,
            function(col, cell, model, iter) {
                let id = model.get_value(iter, Gd.MainColumns.ID);
                let doc = Application.documentManager.getItemById(id);

                whereRenderer.text = doc.sourceName;
            }));

        let dateRenderer =
            new Gtk.CellRendererText({ xpad: 32 });
        listWidget.add_renderer(dateRenderer, Lang.bind(this,
            function(col, cell, model, iter) {
                let id = model.get_value(iter, Gd.MainColumns.ID);
                let doc = Application.documentManager.getItemById(id);
                let DAY = 86400000000;

                let now = GLib.DateTime.new_now_local();
                let mtime = GLib.DateTime.new_from_unix_local(doc.mtime);
                let difference = now.difference(mtime);
                let days = Math.floor(difference / DAY);
                let weeks = Math.floor(difference / (7 * DAY));
                let months = Math.floor(difference / (30 * DAY));
                let years = Math.floor(difference / (365 * DAY));

                if (difference < DAY) {
                    dateRenderer.text = mtime.format('%X');
                } else if (difference < 2 * DAY) {
                    dateRenderer.text = _("Yesterday");
                } else if (difference < 7 * DAY) {
                    dateRenderer.text = Gettext.ngettext("%d day ago",
                                                         "%d days ago",
                                                         days).format(days);
                } else if (difference < 14 * DAY) {
                    dateRenderer.text = _("Last week");
                } else if (difference < 28 * DAY) {
                    dateRenderer.text = Gettext.ngettext("%d week ago",
                                                         "%d weeks ago",
                                                         weeks).format(weeks);
                } else if (difference < 60 * DAY) {
                    dateRenderer.text = _("Last month");
                } else if (difference < 360 * DAY) {
                    dateRenderer.text = Gettext.ngettext("%d month ago",
                                                         "%d months ago",
                                                         months).format(months);
                } else if (difference < 730 * DAY) {
                    dateRenderer.text = _("Last year");
                } else {
                    dateRenderer.text = Gettext.ngettext("%d year ago",
                                                         "%d years ago",
                                                         years).format(years);
                }
            }));
    }

    _onSelectionModeRequest() {
        this._selectionModeAction.change_state(GLib.Variant.new('b', true));
    }

    _onItemActivated(widget, id, path) {
        Application.documentManager.setActiveItemById(id);
    }

    _onQueryError(manager, message, exception) {
        this._setError(message, exception.message);
    }

    _onQueryStatusChanged() {
        let status = this._trackerController.getQueryStatus();

        if (!status) {
            // setup a model if we're not querying
            this.view.set_model(this._model);

            // unfreeze selection
            Application.selectionController.freezeSelection(false);
            this._updateSelection();

            // hide the spinner
            this._spinner.stop();
            this.set_visible_child_name('view');
        } else {
            // save the last selection
            Application.selectionController.freezeSelection(true);

            // if we're querying, clear the model from the view,
            // so that we don't uselessly refresh the rows
            this.view.set_model(null);

            // kick off the spinner
            this._spinner.start();
            this.set_visible_child_name('spinner');
        }
    }

    _setError(primary, secondary) {
        this._errorBox.update(primary, secondary);
        this.set_visible_child_name('error');
    }

    _updateSelection() {
        let selected = Application.selectionController.getSelection();
        let newSelection = [];

        if (!selected.length)
            return;

        let generic = this.view.get_generic_view();
        let first = true;
        this._model.foreach(Lang.bind(this,
            function(model, path, iter) {
                let id = this._model.get_value(iter, Gd.MainColumns.ID);
                let idIndex = selected.indexOf(id);

                if (idIndex != -1) {
                    this._model.set_value(iter, Gd.MainColumns.SELECTED, true);
                    newSelection.push(id);

                    if (first) {
                        generic.scroll_to_path(path);
                        first = false;
                    }
                }

                if (newSelection.length == selected.length)
                    return true;

                return false;
            }));

        Application.selectionController.setSelection(newSelection);
    }

    _onSelectionModeChanged() {
        let selectionMode = this._selectionModeAction.state.get_boolean();
        this.view.set_selection_mode(selectionMode);
    }

    _onViewSelectionChanged() {
        let mode = Application.modeController.getWindowMode();
        if (this._mode != mode)
            return;

        // update the selection on the controller when the view signals a change
        let selectedURNs = Utils.getURNsFromPaths(this.view.get_selection(),
                                                  this._model);
        Application.selectionController.setSelection(selectedURNs);
    }

    _onWindowModeChanged() {
        let mode = Application.modeController.getWindowMode();
        if (mode == this._mode)
            this._connectView();
        else
            this._disconnectView();
    }

    _connectView() {
        this._edgeHitId = this.view.connect('edge-reached', Lang.bind(this,
            function (view, pos) {
                if (pos == Gtk.PositionType.BOTTOM)
                    this._offsetController.increaseOffset();
            }));
    }

    _disconnectView() {
        if (this._edgeHitId != 0) {
            this.view.disconnect(this._edgeHitId);
            this._edgeHitId = 0;
        }
    }

    activateResult() {
        let doc = this._getFirstDocument();
        if (doc)
            Application.documentManager.setActiveItem(doc)
    }

    get model() {
        return this._model;
    }
});

var OverviewStack = GObject.registerClass(
    class OverviewStack extends Gtk.Box {

    _init() {
        super._init({ orientation: Gtk.Orientation.VERTICAL,
                      visible: true });

        let actions = this._getDefaultActions();
        this.actionGroup = new Gio.SimpleActionGroup();
        Utils.populateActionGroup(this.actionGroup, actions, 'view');

        this._stack = new Gtk.Stack({ visible: true });
        this.pack_start(this._stack, true, true, 0);

        // create the toolbar for selected items, it's hidden by default
        this._selectionToolbar = new Selections.SelectionToolbar(this);
        this.pack_end(this._selectionToolbar, false, false, 0);

        // now create the actual content widgets
        this._documents = new ViewContainer(this, WindowMode.WindowMode.DOCUMENTS);
        this._stack.add_titled(this._documents, 'documents', _("Documents"));

        this._collections = new ViewContainer(this, WindowMode.WindowMode.COLLECTIONS);
        this._stack.add_titled(this._collections, 'collections', _("Collections"));

        this._search = new ViewContainer(this, WindowMode.WindowMode.SEARCH);
        this._stack.add_named(this._search, 'search');

        this._stack.connect('notify::visible-child',
                            Lang.bind(this, this._onVisibleChildChanged));
    }

    _getDefaultActions() {
        let backAccels = ['Back'];
        if (this.get_direction() == Gtk.TextDirection.LTR)
            backAccels.push('<Alt>Left');
        else
            backAccels.push('<Alt>Right');

        return [
            { name: 'go-back',
              callback: Lang.bind(this, this._goBack),
              accels: backAccels },
            { name: 'selection-mode',
              callback: Utils.actionToggleCallback,
              state: GLib.Variant.new('b', false),
              stateChanged: Lang.bind(this, this._updateSelectionMode) },
            { name: 'select-all',
              callback: Lang.bind(this, this._selectAll),
              accels: ['<Primary>a'] },
            { name: 'select-none',
              callback: Lang.bind(this, this._selectNone) },
            { settingsKey: 'view-as',
              stateChanged: Lang.bind(this, this._updateTypeForSettings) },
            { settingsKey: 'sort-by',
              stateChanged: Lang.bind(this, this._updateSortForSettings) },
            { name: 'search',
              callback: Utils.actionToggleCallback,
              state: GLib.Variant.new('b', false),
              accels: ['<Primary>f'] },
            { name: 'search-source',
              parameter_type: 's',
              state: GLib.Variant.new('s', Search.SearchSourceStock.ALL),
              stateChanged: Lang.bind(this, this._updateSearchSource),
              create_hook: Lang.bind(this, this._initSearchSource) },
            { name: 'search-type',
              parameter_type: 's',
              state: GLib.Variant.new('s', Search.SearchTypeStock.ALL),
              stateChanged: Lang.bind(this, this._updateSearchType),
              create_hook: Lang.bind(this, this._initSearchType) },
            { name: 'search-match',
              parameter_type: 's',
              state: GLib.Variant.new('s', Search.SearchMatchStock.ALL),
              stateChanged: Lang.bind(this, this._updateSearchMatch),
              create_hook: Lang.bind(this, this._initSearchMatch) }
        ];
    }

    _goBack() {
        Application.documentManager.activatePreviousCollection();
    }

    _selectAll() {
        this.getAction('selection-mode').change_state(GLib.Variant.new('b', true));
        this.view.view.select_all();
    }

    _selectNone() {
        this.view.view.unselect_all();
    }

    _updateTypeForSettings() {
        let viewType = Application.settings.get_enum('view-as');
        this.view.view.set_view_type(viewType);
    }

    _updateSortForSettings() {
        let sortBy = Application.settings.get_enum('sort-by');
        let sortType;

        switch (sortBy) {
        case Gd.MainColumns.PRIMARY_TEXT:
            sortType = Gtk.SortType.ASCENDING;
            break;
        case Gd.MainColumns.SECONDARY_TEXT:
            sortType = Gtk.SortType.ASCENDING;
            break;
        case Gd.MainColumns.MTIME:
            sortType = Gtk.SortType.DESCENDING;
            break;
        default:
            sortBy = Gd.MainColumns.MTIME;
            sortType = Gtk.SortType.DESCENDING;
            break;
        }

        this.view.model.set_sort_column_id(sortBy, sortType);
    }

    _updateSelectionMode(action) {
        let selectionMode = action.state.get_boolean();

        if (selectionMode) {
            Application.application.set_accels_for_action('view.selection-mode', ['Escape']);
            this._selectionToolbar.show();
        } else {
            Application.application.set_accels_for_action('view.selection-mode', []);
            this._selectionToolbar.hide();
        }
    }

    _initSearchSource(action) {
        Application.sourceManager.connect('active-changed', Lang.bind(this, function(manager, activeItem) {
            action.state = GLib.Variant.new('s', activeItem.id);
        }));
    }

    _initSearchType(action) {
        Application.searchTypeManager.connect('active-changed', Lang.bind(this, function(manager, activeItem) {
            action.state = GLib.Variant.new('s', activeItem.id);
        }));
    }

    _initSearchMatch(action) {
        Application.searchMatchManager.connect('active-changed', Lang.bind(this, function(manager, activeItem) {
            action.state = GLib.Variant.new('s', activeItem.id);
        }));
    }

    _updateSearchSource(action) {
        let itemId = action.state.get_string()[0];
        Application.sourceManager.setActiveItemById(itemId);
    }

    _updateSearchType(action) {
        let itemId = action.state.get_string()[0];
        Application.searchTypeManager.setActiveItemById(itemId);
    }

    _updateSearchMatch(action) {
        let itemId = action.state.get_string()[0];
        Application.searchMatchManager.setActiveItemById(itemId);
    }

    _onVisibleChildChanged() {
        let windowMode;

        if (this.view == this._collections)
            windowMode = WindowMode.WindowMode.COLLECTIONS;
        else if (this.view == this._documents)
            windowMode = WindowMode.WindowMode.DOCUMENTS;
        else
            return;

        Application.modeController.setWindowMode(windowMode);
    }

    set windowMode(mode) {
        let visibleChild;

        switch (mode) {
        case WindowMode.WindowMode.COLLECTIONS:
            visibleChild = this._collections;
            break;
        case WindowMode.WindowMode.DOCUMENTS:
            visibleChild = this._documents;
            break;
        case WindowMode.WindowMode.SEARCH:
            visibleChild = this._search;
            break;
        default:
            return;
        }

        this._stack.visible_child = visibleChild;
        this._updateSortForSettings();
        this._updateTypeForSettings();
    }

    activateResult() {
        this.view.activateResult();
    }

    createToolbar() {
        return new OverviewToolbar(this);
    }

    getAction(name) {
        return this.actionGroup.lookup_action(name);
    }

    get stack() {
        return this._stack;
    }

    get view() {
        return this._stack.visible_child;
    }
});
