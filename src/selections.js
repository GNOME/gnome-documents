/*
 * Copyright © 2015 Alessandro Bono
 * Copyright (c) 2011 Red Hat, Inc.
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

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const _ = imports.gettext.gettext;
const C_ = imports.gettext.pgettext;

const Application = imports.application;
const Mainloop = imports.mainloop;
const Notifications = imports.notifications;
const Properties = imports.properties;
const Query = imports.query;
const Sharing = imports.sharing;
const TrackerUtils = imports.trackerUtils;
const WindowMode = imports.windowMode;

const Signals = imports.signals;

// fetch all the collections a given item is part of
const FetchCollectionsJob = class FetchCollectionsJob {
    constructor(urn) {
        this._urn = urn;
        this._collections = [];
    }

    run(callback) {
        this._callback = callback;

        let query = Application.queryBuilder.buildFetchCollectionsQuery(this._urn);
        Application.connectionQueue.add(query.sparql, null, (object, res) => {
            let cursor = null;

            try {
                cursor = object.query_finish(res);
                cursor.next_async(null, this._onCursorNext.bind(this));
            } catch (e) {
                logError(e, 'Unable to run FetchCollectionsJob');
                this._emitCallback();
            }
        });
    }

    _onCursorNext(cursor, res) {
        let valid = false;

        try {
            valid = cursor.next_finish(res);
        } catch (e) {
            logError(e, 'Unable to read results of FetchCollectionsJob');
        }

        if (!valid) {
            cursor.close();
            this._emitCallback();

            return;
        }

        let urn = cursor.get_string(0)[0];
        this._collections.push(urn);

        cursor.next_async(null, this._onCursorNext.bind(this));
    }

    _emitCallback() {
        if (this._callback)
            this._callback(this._collections);
    }
}

// fetch the state of every collection applicable to the selected items
const OrganizeCollectionState = {
    NORMAL: 0,
    ACTIVE: 1 << 0,
    INCONSISTENT: 1 << 1,
    HIDDEN: 1 << 2
};

const FetchCollectionStateForSelectionJob = class FetchCollectionStateForSelectionJob {
    constructor() {
        this._collectionsForItems = {};
        this._runningJobs = 0;
    }

    run(callback) {
        this._callback = callback;

        let urns = Application.selectionController.getSelection();
        urns.forEach((urn) => {
            let job = new FetchCollectionsJob(urn);

            this._runningJobs++;
            job.run(this._jobCollector.bind(this, urn));
        });
    }

    _jobCollector(urn, collectionsForItem) {
        this._collectionsForItems[urn] = collectionsForItem;

        this._runningJobs--;
        if (!this._runningJobs)
            this._emitCallback();
    }

    _emitCallback() {
        let collectionState = {};
        let collections = Application.documentManager.getCollections();

        // for all the registered collections...
        for (let collIdx in collections) {
            let collection = collections[collIdx];

            let found = false;
            let notFound = false;
            let hidden = false;

            // if the only object we are fetching collection state for is a
            // collection itself, hide this if it's the same collection.
            if (Object.keys(this._collectionsForItems).length == 1) {
                let itemIdx = Object.keys(this._collectionsForItems)[0];
                let item = Application.documentManager.getItemById(itemIdx);

                if (item.id == collection.id)
                    hidden = true;
            }

            for (let itemIdx in this._collectionsForItems) {
                let item = Application.documentManager.getItemById(itemIdx);
                let collectionsForItem = this._collectionsForItems[itemIdx];

                // if one of the selected items is part of this collection...
                if (collectionsForItem.indexOf(collIdx) != -1)
                    found = true;
                else
                    notFound = true;

                if ((item.resourceUrn != collection.resourceUrn) &&
                    (collection.identifier.indexOf(Query.LOCAL_DOCUMENTS_COLLECTIONS_IDENTIFIER) == -1)) {
                    hidden = true;
                }
            }

            let state = OrganizeCollectionState.NORMAL;

            if (found && notFound)
                // if some items are part of this collection and some are not...
                state |= OrganizeCollectionState.INCONSISTENT;
            else if (found)
                // if all items are part of this collection...
                state |= OrganizeCollectionState.ACTIVE;

            if (hidden)
                state |= OrganizeCollectionState.HIDDEN;

            collectionState[collIdx] = state;
        }

        if (this._callback)
            this._callback(collectionState);
    }
}

// updates the mtime for the given resource to the current system time
const UpdateMtimeJob = class UpdateMtimeJob {
    constructor(urn) {
        this._urn = urn;
    }

    run(callback) {
        this._callback = callback;

        let query = Application.queryBuilder.buildUpdateMtimeQuery(this._urn);
        Application.connectionQueue.update(query.sparql, null, (object, res) => {
            try {
                object.update_finish(res);
            } catch (e) {
                logError(e, 'Unable to run UpdateMtimeJob');
            }

            if (this._callback)
                this._callback();
        });
    }
}

// adds or removes the selected items to the given collection
const SetCollectionForSelectionJob = class SetCollectionForSelectionJob {
    constructor(collectionUrn, setting) {
        this._collectionUrn = collectionUrn;
        this._setting = setting;
        this._runningJobs = 0;
    }

    run(callback) {
        this._callback = callback;

        let urns = Application.selectionController.getSelection();
        urns.forEach((urn) => {
            // never add a collection to itself!!
            if (urn == this._collectionUrn)
                return;

            let query = Application.queryBuilder.buildSetCollectionQuery(
                urn, this._collectionUrn, this._setting);
            this._runningJobs++;

            Application.connectionQueue.update(query.sparql, null, (object, res) => {
                try {
                    object.update_finish(res);
                } catch (e) {
                    logError(e, 'Unable to run SetCollectionForSelectionJob');
                }

                this._jobCollector();
            });
        });
    }

    _jobCollector() {
        this._runningJobs--;

        if (this._runningJobs == 0) {
            let job = new UpdateMtimeJob(this._collectionUrn);
            job.run(() => {
                if (this._callback)
                    this._callback();
            });
        }
    }
}

// creates an (empty) collection with the given name
const CreateCollectionJob = class CreateCollectionJob {
    constructor(name) {
        this._name = name;
        this._createdUrn = null;
    }

    run(callback) {
        this._callback = callback;

        let query = Application.queryBuilder.buildCreateCollectionQuery(this._name);
        Application.connectionQueue.updateBlank(query.sparql, null, (object, res) => {
            let variant = null;
            try {
                variant = object.update_blank_finish(res); // variant is aaa{ss}
            } catch (e) {
                logError(e, 'Unable to run CreateCollectionJob');
            }

            variant = variant.get_child_value(0); // variant is now aa{ss}
            variant = variant.get_child_value(0); // variant is now a{ss}
            variant = variant.get_child_value(0); // variant is now {ss}

            let key = variant.get_child_value(0).get_string()[0];
            let val = variant.get_child_value(1).get_string()[0];

            if (key == 'res')
                this._createdUrn = val;

            if (this._callback)
                this._callback(this._createdUrn);
        });
    }
}

const CollectionRowViews = {
    DEFAULT: 'default-view',
    DELETE: 'delete-view',
    RENAME: 'rename-view'
};

const CollectionRow = GObject.registerClass(class CollectionRow extends Gtk.ListBoxRow {
    _init(collection, collectionState) {
        this.collection = collection;
        this._collectionState = collectionState;
        this._timeoutId = 0;
        this.views = new Gtk.Stack();
        super._init();
        this.add(this.views);
        this.setDefaultView();
    }

    _initDefaultView() {
        let isActive = (this._collectionState & OrganizeCollectionState.ACTIVE);
        let isInconsistent = (this._collectionState & OrganizeCollectionState.INCONSISTENT);

        let grid = new Gtk.Grid({ margin_top: 6,
                                  margin_bottom: 6,
                                  margin_start: 12,
                                  margin_end: 12,
                                  orientation: Gtk.Orientation.HORIZONTAL });
        this.checkButton = new Gtk.CheckButton({ label: this.collection.name,
                                                 expand: true,
                                                 active: isActive,
                                                 inconsistent: isInconsistent });
        this.checkButton.get_child().set_ellipsize(Pango.EllipsizeMode.END);
        this.checkButton.connect('toggled', (checkButton) => {
            let collId = this.collection.id;
            let state = checkButton.get_active();

            let job = new SetCollectionForSelectionJob(collId, state);
            job.run();
        });
        let menu = new Gio.Menu();
        if (this.collection.canEdit())
            menu.append(_("Rename…"), 'dialog.rename-collection(\'' + this.collection.id + '\')');
        else
            menu.append(_("Rename…"), 'dialog.action-disabled');

        let activeCollection = Application.documentManager.getActiveCollection();
        if (this.collection.canTrash() && this.collection != activeCollection)
            menu.append(_("Delete"), 'dialog.delete-collection(\'' + this.collection.id + '\')');
        else
            menu.append(_("Delete"), 'dialog.action-disabled');

        let menuButton = new Gtk.MenuButton({ image: new Gtk.Image({ icon_name: 'open-menu-symbolic' }),
                                              menu_model: menu,
                                              relief: Gtk.ReliefStyle.NONE });

        grid.add(this.checkButton);
        grid.add(menuButton);
        grid.show_all();
        this.views.add_named(grid, CollectionRowViews.DEFAULT);
    }

    _initDeleteView() {
        let grid = new Gtk.Grid({ margin: 6, orientation: Gtk.Orientation.HORIZONTAL });
        let message = _("“%s” removed").format(this.collection.name);
        let deleteLabel = new Gtk.Label({ label: message,
                                          ellipsize: Pango.EllipsizeMode.MIDDLE,
                                          expand: true,
                                          halign: Gtk.Align.START });
        let undoButton = new Gtk.Button({ label: _("Undo") });
        undoButton.connect('clicked', () => {
            this._resetTimeout()
            this.views.set_transition_type(Gtk.StackTransitionType.SLIDE_RIGHT);
            this.views.set_transition_duration(200);
            this.setDefaultView();
        });
        grid.add(deleteLabel);
        grid.add(undoButton);

        grid.show_all();
        this.views.add_named(grid, CollectionRowViews.DELETE);
    }

    _initRenameView() {
        this.renameEntry = new Gtk.Entry({ activates_default: true,
                                           expand: true,
                                           text: this.collection.name,
                                           secondary_icon_name: 'edit-clear-symbolic'});
        this.renameEntry.connect('icon-press', (renameEntry, iconPos) => {
            if (iconPos == Gtk.EntryIconPosition.SECONDARY) {
                renameEntry.set_text("");
            }
        });
        this.renameEntry.connect('changed', (renameEntry) => {
            if (renameEntry.get_text() != "")
                renameEntry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, 'edit-clear-symbolic');
            else
                renameEntry.set_icon_from_icon_name(Gtk.EntryIconPosition.SECONDARY, null);
        });
        this.renameEntry.show();
        this.views.add_named(this.renameEntry, CollectionRowViews.RENAME);
    }

    _resetTimeout() {
        if (this._timeoutId != 0) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    applyRename() {
        let newName = this.renameEntry.get_text();
        this.collection.name = newName;
        TrackerUtils.setEditedName(newName, this.collection.id, null);
        this.checkButton.set_label(newName);
    }

    conceal() {
        let revealer = new Gtk.Revealer({ reveal_child: true, transition_duration: 500 });
        revealer.show();
        // inserting revealer between (this) and (this.views)
        this.remove(this.views);
        revealer.add(this.views);
        this.add(revealer);

        revealer.connect("notify::child-revealed", this.deleteCollection.bind(this));
        revealer.reveal_child = false;
    }

    deleteCollection() {
        this._resetTimeout();
        Application.documentManager.removeItem(this.collection);
        this.collection.trash();
    }

    setDefaultView() {
        if (!this.views.get_child_by_name(CollectionRowViews.DEFAULT))
            this._initDefaultView();

        this.get_style_context().remove_class('delete-row');
        this.views.set_visible_child_name(CollectionRowViews.DEFAULT);
    }

    setDeleteView() {
        if (!this.views.get_child_by_name(CollectionRowViews.DELETE))
            this._initDeleteView();

        this._timeoutId = Mainloop.timeout_add_seconds(Notifications.DELETE_TIMEOUT, () => {
            this._timeoutId = 0;
            this.conceal();
            return false;
        });
        this.views.set_transition_type(Gtk.StackTransitionType.SLIDE_LEFT);
        this.views.set_transition_duration(500);
        this.get_style_context().add_class('delete-row');
        this.views.set_visible_child_name(CollectionRowViews.DELETE);

    }

    setRenameView(onTextChanged) {
        if (!this.views.get_child_by_name(CollectionRowViews.RENAME)) {
            this._initRenameView();
            this.renameEntry.connect('changed', onTextChanged);
        }

        this.views.set_transition_type(Gtk.StackTransitionType.CROSSFADE);
        this.views.set_transition_duration(200);
        this.renameEntry.set_text(this.collection.name);
        this.views.set_visible_child_name(CollectionRowViews.RENAME);
    }

});

const CollectionList = GObject.registerClass(class CollectionList extends Gtk.ListBox {
    _init() {
        super._init({ vexpand: false,
                      margin: 0,
                      selection_mode: Gtk.SelectionMode.NONE });

        let collAddedId = Application.documentManager.connect('item-added', this._onCollectionAdded.bind(this));
        let collRemovedId = Application.documentManager.connect('item-removed', this._onCollectionRemoved.bind(this));

        this.set_header_func((row, before) => {
            if (!before) {
                row.set_header(null);
                return;
            }
            let current = row.get_header();
            if (!current) {
                current = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
                row.set_header(current);
            }
        });

        this.set_sort_func((row1, row2) => {
            return row2.collection.mtime - row1.collection.mtime;
        });

        this.connect('destroy', () => {
            let rows = this.get_children();
            rows.forEach(function(row) {
                let currentView = row.views.get_visible_child_name();
                if (currentView == CollectionRowViews.DELETE) {
                    row.deleteCollection();
                }
            });
            Application.documentManager.disconnect(collAddedId);
            Application.documentManager.disconnect(collRemovedId);
        });

        // populate the list
        let job = new FetchCollectionStateForSelectionJob();
        job.run(this._onFetchCollectionStateForSelection.bind(this));
    }

    _onCollectionAdded(manager, itemAdded) {
        if (!itemAdded.collection)
            return;

        let collection =  new CollectionRow(itemAdded, OrganizeCollectionState.ACTIVE);
        collection.show_all();
        this.add(collection);
    }

    _onCollectionRemoved(manager, itemRemoved) {
        if (!itemRemoved.collection)
            return;

        let rows = this.get_children();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].collection.id == itemRemoved.id) {
                this.remove(rows[i]);
                return;
            }
        }
    }

    _onFetchCollectionStateForSelection(collectionState) {
        for (let idx in collectionState) {
            let item = Application.documentManager.getItemById(idx);

            if ((collectionState[item.id] & OrganizeCollectionState.HIDDEN) != 0)
                continue;

            let collection = new CollectionRow(item, collectionState[item.id]);
            collection.show_all();

            this.add(collection);
        }
    }

    isEmpty() {
        let rows = this.get_children();
        return (rows.length == 0);
    }

    isValidName(name) {
        if (!name || name == '')
            return false;

        let rows = this.get_children();
        for (let i = 0; i < rows.length; i++) {
            if (rows[i].collection.name == name)
                return false;
        }

        return true;
    }
});

const OrganizeCollectionDialog = GObject.registerClass({
    Template: 'resource:///org/gnome/Documents/ui/organize-collection-dialog.ui',
    InternalChildren: [ 'content',
                        'viewEmpty',
                        'addEntryEmpty',
                        'addButtonEmpty',
                        'viewSpinner',
                        'viewCollections',
                        'addGridCollections',
                        'addEntryCollections',
                        'addButtonCollections',
                        'scrolledWindowCollections',
                        'headerBar',
                        'cancelButton',
                        'doneButton' ],
}, class OrganizeCollectionDialog extends Gtk.Window {
    _init(toplevel) {
        super._init({ transient_for: toplevel });

        this._renameMode = false;

        this._keyPressEventId = this.connect('key-press-event', this._onKeyPressed.bind(this));
        this._addButtonEmpty.connect('clicked', this._onAddClicked.bind(this));
        this._addButtonCollections.connect('clicked', this._onAddClicked.bind(this));
        this._addEntryEmpty.connect('changed', this._onTextChanged.bind(this));
        this._addEntryCollections.connect('changed', this._onTextChanged.bind(this));

        let actionGroup = new Gio.SimpleActionGroup();
        let deleteAction = new Gio.SimpleAction({ name: 'delete-collection',
                                                  parameter_type: GLib.VariantType.new('s') });
        let renameAction = new Gio.SimpleAction({ name: 'rename-collection',
                                                  parameter_type: GLib.VariantType.new('s') });
        actionGroup.add_action(deleteAction);
        actionGroup.add_action(renameAction);
        this.insert_action_group('dialog', actionGroup);

        renameAction.connect('activate', this._renameModeStart.bind(this));
        deleteAction.connect('activate', (action, parameter) => {
            let collId = parameter.get_string()[0];
            let rows = this._collectionList.get_children();
            rows.forEach(function(row) {
                if (row.collection.id != collId)
                    return;

                row.setDeleteView();
            });
        });

        this._cancelButton.connect('clicked', () => { this._renameModeStop(false); });
        this._doneButton.connect('clicked', () => { this._renameModeStop(true); });

        this._collectionList = new CollectionList();
        let addId = this._collectionList.connect('add', this._onCollectionListChanged.bind(this));
        let removeId = this._collectionList.connect('remove', this._onCollectionListChanged.bind(this));
        this._scrolledWindowCollections.add(this._collectionList);

        this.show_all();

        this.connect('destroy', () => {
            this._collectionList.disconnect(addId);
            this._collectionList.disconnect(removeId);
        });

        /* We want a CROSSFADE effect when switching from ViewEmpty to ViewCollections (and the other way around)
         * but when we create the dialog we don't want to see the effect, so for the first second we don't use
         * any effect and after that we use the CROSSFADE effect.
         */
        Mainloop.timeout_add_seconds(1, () => {
            this._content.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
            return false;
        });
    }

    _onAddClicked() {
        let addEntry = this._collectionList.isEmpty() ? this._addEntryEmpty : this._addEntryCollections;
        let newText = addEntry.get_text();
        let job = new CreateCollectionJob(newText);
        job.run((createdUrn) => {
            if (!createdUrn)
                return;

            addEntry.set_text('');
            let job = new SetCollectionForSelectionJob(createdUrn, true);
            job.run(null);
        });
        if (this._collectionList.isEmpty()) {
            this._viewSpinner.start();
            this._content.set_visible_child(this._viewSpinner);
        } else {
            this._scrolledWindowCollections.get_vadjustment().set_value(0);
        }
    }

    _onTextChanged(entry) {
        let sensitive = this._collectionList.isValidName(entry.get_text());
        if (this._renameMode)
            this._doneButton.set_sensitive(sensitive);
        else {
            let addButton = this._collectionList.isEmpty() ? this._addButtonEmpty : this._addButtonCollections;
            addButton.set_sensitive(sensitive);
        }
    }

    _onKeyPressed (window, event) {
        let keyval = event.get_keyval()[1];
        if (keyval == Gdk.KEY_Escape) {
            if (this._renameMode)
                this._renameModeStop(false);
            else
                this.destroy();

            return Gdk.EVENT_STOP;
        }
        return Gdk.EVENT_PROPAGATE;
    }

    _renameModeStart(action, parameter) {
        let collId = parameter.get_string()[0];
        this._setRenameMode(true);

        let rows = this._collectionList.get_children();
        rows.forEach((row) => {
            let currentView = row.views.get_visible_child_name();
            if (currentView == CollectionRowViews.DELETE) {
                row.conceal();
                return;
            }

            if (row.collection.id != collId) {
                row.set_sensitive(false);
                return;
            }

            row.setRenameView(this._onTextChanged.bind(this));
        });
    }

    _renameModeStop(rename) {
        this._setRenameMode(false);

        let rows = this._collectionList.get_children();
        rows.forEach(function(row) {
            let currentView = row.views.get_visible_child_name();
            if (currentView != CollectionRowViews.RENAME) {
                row.set_sensitive(true);
                return;
            }

            if (rename)
                row.applyRename();

            row.setDefaultView();
        });
    }

    _onCollectionListChanged() {
        if (this._collectionList.isEmpty()) {
            this._viewSpinner.stop();
            this._content.set_visible_child(this._viewEmpty);
            this._addEntryEmpty.grab_focus();
            this._addButtonEmpty.grab_default();
        } else {
            this._viewSpinner.stop();
            this._content.set_visible_child(this._viewCollections);
            this._addEntryCollections.grab_focus();
            this._addButtonCollections.grab_default();
        }
    }

    _setRenameMode(renameMode) {
        this._renameMode = renameMode;
        if (this._renameMode) {
            this._headerBar.set_title(_("Rename"));
            this._cancelButton.show();
            this._doneButton.show();
            this._doneButton.grab_default();
        } else {
            // Translators: "Collections" refers to documents in this context
            this._headerBar.set_title(C_("Dialog Title", "Collections"));
            this._cancelButton.hide();
            this._doneButton.hide();
            let addButton = this._collectionList.isEmpty() ? this._addButtonEmpty : this._addButtonCollections;
            addButton.grab_default();
        }
        this._headerBar.set_show_close_button(!this._renameMode);
        this._addGridCollections.set_sensitive(!this._renameMode);
    }
});

var SelectionController = class SelectionController {
    constructor() {
        this._selection = [];

        Application.documentManager.connect('item-removed', this._onDocumentRemoved.bind(this));
    }

    _onDocumentRemoved(manager, item) {
        let changed = false;
        let filtered = this._selection.filter((value, index) => {
            if (item.id == value)
                changed = true;

            return (item.id != value);
        });
        if (changed) {
            this._selection = filtered;
            this.emit('selection-changed', this._selection);
        }
    }

    setSelection(selection) {
        if (this._isFrozen)
            return;

        if (!selection)
            this._selection = [];
        else
            this._selection = selection;

        this.emit('selection-changed', this._selection);
    }

    getSelection() {
        return this._selection;
    }

    freezeSelection(freeze) {
        if (freeze == this._isFrozen)
            return;

        this._isFrozen = freeze;
    }
}
Signals.addSignalMethods(SelectionController.prototype);

const _SELECTION_TOOLBAR_DEFAULT_WIDTH = 500;

var SelectionToolbar = GObject.registerClass({
    Template: 'resource:///org/gnome/Documents/ui/selection-toolbar.ui',
    InternalChildren: [ 'toolbarOpen',
                        'toolbarPrint',
                        'toolbarTrash',
                        'toolbarShare',
                        'toolbarProperties',
                        'toolbarCollection' ],
}, class SelectionToolbar extends Gtk.ActionBar {

    _init(overview) {
        this._docToPrint = null;
        this._docBeginPrintId = 0;
        this._itemListeners = {};
        this._insideRefresh = false;

        super._init();

        this._selectionModeAction = overview.getAction('selection-mode');

        this._toolbarOpen.connect('clicked', this._onToolbarOpen.bind(this));
        this._toolbarPrint.connect('clicked', this._onToolbarPrint.bind(this));
        this._toolbarTrash.connect('clicked', this._onToolbarTrash.bind(this));

        this._toolbarShare.connect('clicked', this._onToolbarShare.bind(this));
        this._toolbarShare.show();

        this._toolbarProperties.connect('clicked', this._onToolbarProperties.bind(this));
        this._toolbarCollection.connect('clicked', this._onToolbarCollection.bind(this));

        Application.modeController.connect('window-mode-changed', this._updateCollectionsButton.bind(this));
        Application.documentManager.connect('active-collection-changed', this._updateCollectionsButton.bind(this));

        Application.selectionController.connect('selection-changed', this._onSelectionChanged.bind(this));
        this._onSelectionChanged();

        this.connect('destroy', () => {
            this._disconnectDocToPrint();
        });
    }

    vfunc_hide() {
        this._disconnectDocToPrint();
        super.vfunc_hide();
    }

    _disconnectDocToPrint() {
        if (this._docToPrint != null && this._docBeginPrintId != 0) {
            this._docToPrint.disconnect(this._docBeginPrintId);
            this._docToPrint = null;
            this._docBeginPrintId = 0;
        }
    }

    _updateCollectionsButton() {
        let windowMode = Application.modeController.getWindowMode();
        let activeCollection = Application.documentManager.getActiveCollection();
        if (windowMode == WindowMode.WindowMode.COLLECTIONS && !activeCollection)
            this._toolbarCollection.hide();
        else
            this._toolbarCollection.show();
    }

    _onSelectionChanged() {
        let selection = Application.selectionController.getSelection();
        this._setItemListeners(selection);

        this._setItemVisibility();
    }

    _setItemListeners(selection) {
        for (let idx in this._itemListeners) {
            let doc = this._itemListeners[idx];
            doc.disconnect(idx);
            delete this._itemListeners[idx];
        }

        selection.forEach((urn) => {
            let doc = Application.documentManager.getItemById(urn);
            let id = doc.connect('info-updated', this._setItemVisibility.bind(this));
            this._itemListeners[id] = doc;
        });
    }

    _setItemVisibility() {
        let apps = [];
        let selection = Application.selectionController.getSelection();
        let hasSelection = (selection.length > 0);

        let showTrash = hasSelection;
        let showPrint = false;
        let showProperties = hasSelection;
        let showOpen = hasSelection;
        let showShare = hasSelection;
        let showCollection = hasSelection;

        this._insideRefresh = true;

        selection.forEach((urn) => {
            let doc = Application.documentManager.getItemById(urn);

            if ((doc.defaultAppName) &&
                (apps.indexOf(doc.defaultAppName) == -1))
                apps.push(doc.defaultAppName);
            if (!doc.canShare() ||
                (doc.collection != false) ||
                (selection.length > 1))
                showShare = false;

            showTrash &= doc.canTrash();
        });

        showOpen = (apps.length > 0);

        if (selection.length == 1) {
            let doc = Application.documentManager.getItemById(selection[0]);
            if (!doc.collection) {
                doc.load(null, null, (doc, docModel, error) => {
                    showPrint = doc.canPrint(docModel);
                    this._toolbarPrint.set_sensitive(showPrint);
                });
            }
        }

        if (selection.length > 1)
            showProperties = false;

        let openLabel = null;
        if (apps.length == 1) {
            // Translators: this is the Open action in a context menu
            openLabel = _("Open with %s").format(apps[0]);
        } else {
            // Translators: this is the Open action in a context menu
            openLabel = _("Open");
        }
        this._toolbarOpen.set_label(openLabel);

        this._toolbarPrint.set_sensitive(showPrint);
        this._toolbarProperties.set_sensitive(showProperties);
        this._toolbarTrash.set_sensitive(showTrash);
        this._toolbarOpen.set_sensitive(showOpen);
        this._toolbarShare.set_sensitive(showShare);
        this._toolbarCollection.set_sensitive(showCollection);

        this._insideRefresh = false;
    }

    _onToolbarCollection() {
        let toplevel = this.get_toplevel();
        if (!toplevel.is_toplevel())
            throw(new Error('Code should not be reached'));

        let dialog = new OrganizeCollectionDialog(toplevel);
        dialog.connect('destroy', () => {
            this._selectionModeAction.change_state(GLib.Variant.new('b', false));
        });
    }

    _onToolbarOpen(widget) {
        let selection = Application.selectionController.getSelection();
        this._selectionModeAction.change_state(GLib.Variant.new('b', false));

        selection.forEach((urn) => {
            let doc = Application.documentManager.getItemById(urn);
            let toplevel = this.get_toplevel();
            if (!toplevel.is_toplevel())
                throw(new Error('Code should not be reached'));

            doc.open(toplevel, Gtk.get_current_event_time());
        });
    }

    _onToolbarTrash(widget) {
        let selection = Application.selectionController.getSelection();
        let docs = [];

        selection.forEach((urn) => {
            let doc = Application.documentManager.getItemById(urn);
            docs.push(doc);
        });

        // Removing an item from DocumentManager changes the selection, so
        // we can't use the selection while removing items.
        docs.forEach((doc) => {
            Application.documentManager.removeItem(doc);
        });

        let deleteNotification = new Notifications.DeleteNotification(docs);
        this._selectionModeAction.change_state(GLib.Variant.new('b', false));
    }

    _onToolbarProperties(widget) {
        let selection = Application.selectionController.getSelection();
        let dialog = new Properties.PropertiesDialog(selection[0]);

        dialog.connect('response', (widget, response) => {
            dialog.destroy();
            this._selectionModeAction.change_state(GLib.Variant.new('b', false));
        });
    }

   _onToolbarShare(widget) {
       let dialog = new Sharing.SharingDialog();

       dialog.connect('response', (widget, response) => {
           dialog.destroy();
           this._selectionModeAction.change_state(GLib.Variant.new('b', false));
       });
    }

    _onToolbarPrint(widget) {
        let selection = Application.selectionController.getSelection();

        if (selection.length != 1)
            return;

        this._disconnectDocToPrint();

        this._docToPrint = Application.documentManager.getItemById(selection[0]);
        this._docBeginPrintId = this._docToPrint.connect('begin-print', (doc) => {
            this._selectionModeAction.change_state(GLib.Variant.new('b', false));
        });

        this._docToPrint.print(this.get_toplevel());
    }
});
