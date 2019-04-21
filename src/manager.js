/*
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

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;

const Lang = imports.lang;
const Signals = imports.signals;

var BaseManager = GObject.registerClass(
    class BaseManager extends GObject.Object {

    _init(title, actionId, context) {
        this._items = {};
        this._activeItem = null;
        this._title = null;
        this._actionId = null;

        if (title)
            this._title = title;

        if (actionId)
            this._actionId = actionId;

        this.context = context;
    }

    getActionId() {
        return this._actionId;
    }

    getTitle() {
        return this._title;
    }

    getItemById(id) {
        let retval = this._items[id];

        if (!retval)
            retval = null;

        return retval;
    }

    addItem(item) {
        item._manager = this;

        let oldItem = this._items[item.id];
        if (oldItem)
            this.removeItem(oldItem);

        this._items[item.id] = item;
        this.emit('item-added', item);
    }

    setActiveItem(item) {
        if (item != this._activeItem) {
            this._activeItem = item;
            this.emit('active-changed', this._activeItem);

            return true;
        }

        return false;
    }

    setActiveItemById(id) {
        let item = this.getItemById(id);
        return this.setActiveItem(item);
    }

    getItems() {
        return this._items;
    }

    getItemsCount() {
        return Object.keys(this._items).length;
    }

    getActiveItem() {
        return this._activeItem;
    }

    removeItem(item) {
        this.removeItemById(item.id);
    }

    removeItemById(id) {
        let item = this._items[id];

        if (item) {
            delete this._items[id];
            this.emit('item-removed', item);
            item._manager = null;
        }
    }

    clear() {
        this._items = {};
        this._activeItem = null;
        this.emit('clear');
    }

    getFilter(flags) {
        log('Error: BaseManager implementations must override getFilter');
    }

    getWhere() {
        let item = this.getActiveItem();
        let retval = '';

        if (item && item.getWhere)
            retval = item.getWhere();

        return retval;
    }

    forEachItem(func) {
        for (let idx in this._items)
            func(this._items[idx]);
    }

    getAllFilter() {
        let filters = [];

        this.forEachItem(function(item) {
            if (item.id != 'all')
                filters.push(item.getFilter());
        });

        return '(' + filters.join(' || ') + ')';
    }

    processNewItems(newItems) {
        let oldItems = this.getItems();
        let idx;

        for (idx in oldItems) {
            let item = oldItems[idx];

            // if old items are not found in the new array,
            // remove them
            if (!newItems[idx] && !item.builtin)
                this.removeItem(oldItems[idx]);
        }

        for (idx in newItems) {
            // if new items are not found in the old array,
            // add them
            if (!oldItems[idx])
                this.addItem(newItems[idx]);
        }

        // TODO: merge existing item properties with new values
    }
});
Signals.addSignalMethods(BaseManager.prototype);

var BaseModel = GObject.registerClass(
    class BaseModel extends Gio.Menu {

    _init(manager) {
        super._init();
        this._manager = manager;
        this._manager.connect('item-added', Lang.bind(this, this._refreshModel));
        this._manager.connect('item-removed', Lang.bind(this, this._refreshModel));

        this._refreshModel();
    }

    _refreshModel() {
        this.remove_all();

        let menuItem;
        let title = this._manager.getTitle();
        let actionId = this._manager.getActionId();

        let section = new Gio.Menu();
        this.append_section(title, section);

        let items = this._manager.getItems();
        for (let idx in items) {
            let item = items[idx];
            menuItem = new Gio.MenuItem();
            menuItem.set_action_and_target_value(actionId, GLib.Variant.new('s', item.id));
            menuItem.set_label(item.name);
            section.append_item(menuItem);
        }
    }
});
