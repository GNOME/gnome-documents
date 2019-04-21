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
const Edit = imports.edit;
const EvinceView = imports.evinceview;
const LOKView = imports.lokview;
const Search = imports.search;
const Overview = imports.overview;
const WindowMode = imports.windowMode;

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const View = GObject.registerClass(
    class View extends Gtk.Overlay {

    _init(window) {
        this._toolbar = null;
        this._window = window;

        super._init();

        this._stack = new Gtk.Stack({ visible: true,
                                      homogeneous: true,
                                      transition_type: Gtk.StackTransitionType.CROSSFADE });
        this.add(this._stack);

        // pack the OSD notification widget
        this.add_overlay(Application.notificationManager);

        this.show();
    }

    _clearPreview() {
        if (this._preview) {
            this._preview.destroy();
            this._preview = null;
        }
    }

    _createPreview(mode) {
        let constructor;
        switch (mode) {
        case WindowMode.WindowMode.PREVIEW_EV:
            constructor = EvinceView.EvinceView;
            break;
        case WindowMode.WindowMode.PREVIEW_LOK:
            constructor = LOKView.LOKView;
            break;
        case WindowMode.WindowMode.EDIT:
            constructor = Edit.EditView;
            break;
        default:
            return;
        }

        this._preview = new constructor(this, this._window);
        this._stack.add_named(this._preview, 'preview');
    }

    _ensureOverview(mode) {
        if (!this._overview) {
            this._overview = new Overview.OverviewStack();
            this._stack.add_named(this._overview, 'overview');
        }

        this._overview.windowMode = mode;
    }

    _onActivateResult() {
        this.view.activateResult();
    }

    set windowMode(mode) {
        let fromPreview = !!this._preview;
        this._clearPreview();

        switch (mode) {
        case WindowMode.WindowMode.COLLECTIONS:
        case WindowMode.WindowMode.DOCUMENTS:
        case WindowMode.WindowMode.SEARCH:
            this._ensureOverview(mode);
            this._stack.visible_child = this._overview;
            break;
        case WindowMode.WindowMode.PREVIEW_EV:
        case WindowMode.WindowMode.PREVIEW_LOK:
        case WindowMode.WindowMode.EDIT:
            this._createPreview(mode);
            this._stack.visible_child = this._preview;
            break;
        default:
            return;
        }

        this._window.insert_action_group('view', this.view.actionGroup);

        let createToolbar = true;
        if (!this._preview)
            createToolbar = fromPreview || !this._toolbar;

        if (createToolbar) {
            if (this._toolbar)
                this._toolbar.destroy();

            if (this._preview)
                this._toolbar = this._preview.toolbar;
            else
                this._toolbar = this.view.createToolbar(this._stack);

            if (this._toolbar.searchbar)
                this._toolbar.searchbar.connect('activate-result',
                                                Lang.bind(this, this._onActivateResult));
            this._window.get_titlebar().add(this._toolbar);
        }
    }

    get toolbar() {
        return this._toolbar;
    }

    get view() {
        return this._stack.visible_child;
    }
});

var Embed = GObject.registerClass(
    class Embed extends Gtk.Box {

    _init(mainWindow) {
        super._init({ orientation: Gtk.Orientation.VERTICAL,
                      visible: true });

        let titlebar = new Gtk.Grid({ visible: true });
        mainWindow.set_titlebar(titlebar);

        this._view = new View(mainWindow);
        this.pack_end(this._view, true, true, 0);

        Application.modeController.connect('window-mode-changed',
                                           Lang.bind(this, this._onWindowModeChanged));

        Application.searchTypeManager.connect('active-changed',
                                              Lang.bind(this, this._onSearchChanged));
        Application.sourceManager.connect('active-changed',
                                          Lang.bind(this, this._onSearchChanged));

        Application.searchController.connect('search-string-changed',
                                             Lang.bind(this, this._onSearchChanged));

        this._view.windowMode = Application.modeController.getWindowMode();
    }

    _onSearchChanged() {
        // Whenever a search constraint is specified we want to switch to
        // the search mode, and when all constraints have been lifted we
        // want to go back to the previous mode which can be either
        // collections or documents.
        //
        // However there are some exceptions, which are taken care of
        // elsewhere:
        //  - when moving from search to collection view
        let doc = Application.documentManager.getActiveItem();
        let windowMode = Application.modeController.getWindowMode();
        if (windowMode == WindowMode.WindowMode.SEARCH && doc)
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
            let searchAction = this._view.view.getAction('search');
            searchAction.change_state(GLib.Variant.new('b', true));
        }
    }

    _onWindowModeChanged(object, newMode, oldMode) {
        this._view.windowMode = newMode;
    }

    getMainToolbar() {
        if (this._view.view.canFullscreen &&
            this._view.view.fullscreen)
            return this._view.view.getFullscreenToolbar();

        return this._view.toolbar;
    }

    get view() {
        return this._view;
    }
});
