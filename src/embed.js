/*
 * Copyright (c) 2011, 2013, 2015 Red Hat, Inc.
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

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const MainToolbar = imports.mainToolbar;
const Password = imports.password;
const Edit = imports.edit;
const Search = imports.search;
const Selections = imports.selections;
const View = imports.view;
const WindowMode = imports.windowMode;
const Documents = imports.documents;

const EvView = imports.gi.EvinceView;
const EvinceView = imports.evinceview;
const LOKView = imports.lokview;
const EPUBView = imports.epubview;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const _ICON_SIZE = 32;
const _PDF_LOADER_TIMEOUT = 400;

const Embed = new Lang.Class({
    Name: 'Embed',
    Extends: Gtk.Box,

    _init: function(mainWindow) {
        this._loadShowId = 0;
        this._searchState = null;
        this._window = mainWindow;

        this.parent({ orientation: Gtk.Orientation.VERTICAL,
                      visible: true });

        let toplevel = Application.application.get_windows()[0];
        this._titlebar = new Gtk.Grid({ visible: true });
        toplevel.set_titlebar(this._titlebar);

        // create the toolbar for selected items, it's hidden by default
        this._selectionToolbar = new Selections.SelectionToolbar();
        this.pack_end(this._selectionToolbar, false, false, 0);

        this._stackOverlay = new Gtk.Overlay({ visible: true });
        this.pack_end(this._stackOverlay, true, true, 0);

        this._stack = new Gtk.Stack({ visible: true,
                                      homogeneous: true,
                                      transition_type: Gtk.StackTransitionType.CROSSFADE });
        this._stackOverlay.add(this._stack);

        // pack the OSD notification widget
        this._stackOverlay.add_overlay(Application.notificationManager);

        // now create the actual content widgets
        this._documents = new View.ViewContainer(WindowMode.WindowMode.DOCUMENTS);
        let label = Application.application.isBooks ? _('Books') : _("Documents");
        this._stack.add_titled(this._documents, 'documents', label);

        this._collections = new View.ViewContainer(WindowMode.WindowMode.COLLECTIONS);
        this._stack.add_titled(this._collections, 'collections', _("Collections"));

        this._search = new View.ViewContainer(WindowMode.WindowMode.SEARCH);
        this._stack.add_named(this._search, 'search');

        this._edit = new Edit.EditView();
        this._stack.add_named(this._edit, 'edit');

        this._spinner = new Gtk.Spinner({ width_request: _ICON_SIZE,
                                          height_request: _ICON_SIZE,
                                          halign: Gtk.Align.CENTER,
                                          valign: Gtk.Align.CENTER });
        this._spinner.show();
        this._stack.add_named(this._spinner, 'spinner');

        this._stack.connect('notify::visible-child',
                            Lang.bind(this, this._onVisibleChildChanged));

        Application.modeController.connect('window-mode-changed',
                                           Lang.bind(this, this._onWindowModeChanged));

        Application.modeController.connect('fullscreen-changed',
                                           Lang.bind(this, this._onFullscreenChanged));
        Application.trackerDocumentsController.connect('query-status-changed',
                                                       Lang.bind(this, this._onQueryStatusChanged));

        Application.documentManager.connect('active-changed',
                                            Lang.bind(this, this._onActiveItemChanged));
        Application.documentManager.connect('load-started',
                                            Lang.bind(this, this._onLoadStarted));
        Application.documentManager.connect('load-finished',
                                            Lang.bind(this, this._onLoadFinished));
        Application.documentManager.connect('load-error',
                                            Lang.bind(this, this._onLoadError));
        Application.documentManager.connect('password-needed',
                                            Lang.bind(this, this._onPasswordNeeded));

        Application.searchTypeManager.connect('active-changed',
                                              Lang.bind(this, this._onSearchChanged));
        Application.sourceManager.connect('active-changed',
                                          Lang.bind(this, this._onSearchChanged));

        Application.searchController.connect('search-string-changed',
                                             Lang.bind(this, this._onSearchChanged));

        this._onQueryStatusChanged();

        let windowMode = Application.modeController.getWindowMode();
        if (windowMode != WindowMode.WindowMode.NONE)
            this._onWindowModeChanged(Application.modeController, windowMode, WindowMode.WindowMode.NONE);
    },

    _getViewFromMode: function(windowMode) {
        let view;

        switch (windowMode) {
        case WindowMode.WindowMode.COLLECTIONS:
            view = this._collections;
            break;
        case WindowMode.WindowMode.DOCUMENTS:
            view = this._documents;
            break;
        case WindowMode.WindowMode.PREVIEW_EV:
        case WindowMode.WindowMode.PREVIEW_LOK:
        case WindowMode.WindowMode.PREVIEW_EPUB:
            view = this._preview;
            break;
        case WindowMode.WindowMode.SEARCH:
            view = this._search;
            break;
        default:
            throw(new Error('Not handled'));
            break;
        }

        return view;
    },

    _onActivateResult: function() {
        let windowMode = Application.modeController.getWindowMode();
        let view = this._getViewFromMode(windowMode);
        view.activateResult();
    },

    _restoreLastPage: function() {
        let windowMode = Application.modeController.getWindowMode();
        if (windowMode == WindowMode.WindowMode.NONE)
            return;

        let page;

        switch (windowMode) {
        case WindowMode.WindowMode.COLLECTIONS:
            page = 'collections';
            break;
        case WindowMode.WindowMode.DOCUMENTS:
            page = 'documents';
            break;
        case WindowMode.WindowMode.SEARCH:
            page = 'search';
            break;
        case WindowMode.WindowMode.PREVIEW_EV:
        case WindowMode.WindowMode.PREVIEW_LOK:
        case WindowMode.WindowMode.PREVIEW_EPUB:
            page = 'preview';
            break;
        default:
            throw(new Error('Not handled'));
            break;
        }

        this._stack.set_visible_child_name(page);
    },

    _onQueryStatusChanged: function() {
        let queryStatus = Application.trackerDocumentsController.getQueryStatus();

        if (queryStatus) {
            this._spinner.start();
            this._stack.set_visible_child_name('spinner');
        } else {
            this._spinner.stop();
            this._restoreLastPage();
        }
    },

    _onFullscreenChanged: function(controller, fullscreen) {
        this._toolbar.visible = !fullscreen;
        this._toolbar.sensitive = !fullscreen;
    },

    _onSearchChanged: function() {
        // Whenever a search constraint is specified we want to switch to
        // the search mode, and when all constraints have been lifted we
        // want to go back to the previous mode which can be either
        // collections or documents.
        //
        // However there are some exceptions, which are taken care of
        // elsewhere:
        //  - when moving from search to preview or collection view
        //  - when in preview or coming out of it

        let doc = Application.documentManager.getActiveItem();
        let windowMode = Application.modeController.getWindowMode();
        if (windowMode == WindowMode.WindowMode.SEARCH && doc)
            return;
        if (windowMode == WindowMode.WindowMode.PREVIEW_EV)
            return;

        let searchType = Application.searchTypeManager.getActiveItem();
        let source = Application.sourceManager.getActiveItem();
        let str = Application.searchController.getString();

        if (searchType.id == Search.SearchTypeStock.ALL &&
            source.id == Search.SearchSourceStock.ALL &&
            (!str || str == '')) {
            Application.modeController.goBack();
        } else {
            Application.modeController.setWindowMode(WindowMode.WindowMode.SEARCH);
        }
    },

    _onVisibleChildChanged: function() {
        let visibleChild = this._stack.visible_child;
        let windowMode = WindowMode.WindowMode.NONE;

        if (visibleChild == this._collections)
            windowMode = WindowMode.WindowMode.COLLECTIONS;
        else if (visibleChild == this._documents)
            windowMode = WindowMode.WindowMode.DOCUMENTS;

        if (windowMode == WindowMode.WindowMode.NONE)
            return;

        Application.modeController.setWindowMode(windowMode);
    },

    _onWindowModeChanged: function(object, newMode, oldMode) {
        switch (newMode) {
        case WindowMode.WindowMode.COLLECTIONS:
        case WindowMode.WindowMode.DOCUMENTS:
        case WindowMode.WindowMode.SEARCH:
            this._prepareForOverview(newMode, oldMode);
            break;
        case WindowMode.WindowMode.PREVIEW_EV:
            if (oldMode == WindowMode.WindowMode.EDIT)
                Application.documentManager.reloadActiveItem();
            this._prepareForPreview(EvinceView.EvinceView);
            break;
        case WindowMode.WindowMode.PREVIEW_LOK:
            if (oldMode == WindowMode.WindowMode.EDIT)
                Application.documentManager.reloadActiveItem();
            this._prepareForPreview(LOKView.LOKView);
            break;
        case WindowMode.WindowMode.PREVIEW_EPUB:
            this._prepareForPreview(EPUBView.EPUBView);
            break;
        case WindowMode.WindowMode.EDIT:
            this._prepareForEdit();
            break;
        case WindowMode.WindowMode.NONE:
            break;
         default:
            throw(new Error('Not handled'));
            break;
        }

        if (this._toolbar.searchbar)
            this._toolbar.searchbar.connectJS('activate-result',
                                              Lang.bind(this, this._onActivateResult));
    },

    _restoreSearch: function() {
        if (!this._searchState)
            return;

        Application.searchMatchManager.setActiveItem(this._searchState.searchMatch);
        Application.searchTypeManager.setActiveItem(this._searchState.searchType);
        Application.sourceManager.setActiveItem(this._searchState.source);
        Application.searchController.setString(this._searchState.str);
        this._searchState = null;
    },

    _saveSearch: function() {
        if (this._searchState)
            return;

        this._searchState = new Search.SearchState(Application.searchMatchManager.getActiveItem(),
                                                   Application.searchTypeManager.getActiveItem(),
                                                   Application.sourceManager.getActiveItem(),
                                                   Application.searchController.getString());
    },

    _onActiveItemChanged: function(manager, doc) {
        let windowMode = Application.modeController.getWindowMode();
        let showSearch = (windowMode == WindowMode.WindowMode.PREVIEW_EV && !doc
                          || windowMode == WindowMode.WindowMode.SEARCH && !doc);

        if (showSearch)
            this._restoreSearch();
        else
            this._saveSearch();

        Application.application.change_action_state('search', GLib.Variant.new('b', showSearch));
    },

    _clearLoadTimer: function() {
        if (this._loadShowId != 0) {
            Mainloop.source_remove(this._loadShowId);
            this._loadShowId = 0;
        }
    },

    _onLoadStarted: function(manager, doc) {
        if (LOKView.isOpenDocumentFormat(doc.mimeType))
            Application.modeController.setWindowMode(WindowMode.WindowMode.PREVIEW_LOK);
        else if (EPUBView.isEpub(doc.mimeType))
            Application.modeController.setWindowMode(WindowMode.WindowMode.PREVIEW_EPUB);
        else
            Application.modeController.setWindowMode(WindowMode.WindowMode.PREVIEW_EV);

        this._clearLoadTimer();
        this._loadShowId = Mainloop.timeout_add(_PDF_LOADER_TIMEOUT, Lang.bind(this,
            function() {
                this._loadShowId = 0;

                this._stack.set_visible_child_name('spinner');
                this._spinner.start();
                return false;
            }));
    },

    _onLoadFinished: function(manager, doc, docModel) {
        this._clearLoadTimer();
        this._spinner.stop();

        this._stack.set_visible_child_name('preview');
    },

    _onLoadError: function(manager, doc, message, exception) {
        this._clearLoadTimer();
        this._spinner.stop();
    },

    _onPasswordNeeded: function(manager, doc) {
        this._clearLoadTimer();
        this._spinner.stop();

        let dialog = new Password.PasswordDialog(doc);
        dialog.connect('response', Lang.bind(this,
            function(widget, response) {
                dialog.destroy();
                if (response == Gtk.ResponseType.CANCEL || response == Gtk.ResponseType.DELETE_EVENT)
                    Application.documentManager.setActiveItem(null);
            }));
    },

    _clearViewState: function() {
        if (this._preview) {
            this._preview.destroy();
            this._preview = null;
        }
        if (this._edit)
            this._edit.setUri(null);

        this._window.insert_action_group('view', null);
    },

    _prepareForOverview: function(newMode, oldMode) {
        let createToolbar = (oldMode != WindowMode.WindowMode.COLLECTIONS &&
                             oldMode != WindowMode.WindowMode.DOCUMENTS &&
                             oldMode != WindowMode.WindowMode.SEARCH);

        let visibleChildName;

        switch (newMode) {
        case WindowMode.WindowMode.COLLECTIONS:
            visibleChildName = 'collections';
            break;
        case WindowMode.WindowMode.DOCUMENTS:
            visibleChildName = 'documents';
            break;
        case WindowMode.WindowMode.SEARCH:
            visibleChildName = 'search';
            break;
        default:
            throw(new Error('Not handled'));
            break;
        }

        this._clearViewState();

        if (createToolbar) {
            if (this._toolbar)
                this._toolbar.destroy();

            // pack the toolbar
            this._toolbar = new MainToolbar.OverviewToolbar(this._stack);
            this._titlebar.add(this._toolbar);
        }

        this._spinner.stop();
        this._stack.set_visible_child_name(visibleChildName);
    },

    _prepareForPreview: function(constructor) {
        this._clearViewState();
        if (this._toolbar)
            this._toolbar.destroy();

        this._preview = new constructor(this._stackOverlay, this._window);
        this._window.insert_action_group('view', this._preview.actionGroup);
        this._stack.add_named(this._preview, 'preview');

        // pack the toolbar
        this._toolbar = this._preview.createToolbar();
        this._titlebar.add(this._toolbar);

        this._stack.set_visible_child_name('preview');
    },

    _prepareForEdit: function() {
        this._clearViewState();
        if (this._toolbar)
            this._toolbar.destroy();

        // pack the toolbar
        this._toolbar = new Edit.EditToolbar(this._preview);
        this._titlebar.add(this._toolbar);

        let doc = Application.documentManager.getActiveItem();
        this._edit.setUri(doc.uri);
        this._stack.set_visible_child_name('edit');
    },

    getMainToolbar: function() {
        let windowMode = Application.modeController.getWindowMode();
        let fullscreen = Application.modeController.getFullscreen();

        if (fullscreen && (windowMode == WindowMode.WindowMode.PREVIEW_EV))
            return this._preview.getFullscreenToolbar();
        else
            return this._toolbar;
    },

    getPreview: function() {
        return this._preview;
    }
});
