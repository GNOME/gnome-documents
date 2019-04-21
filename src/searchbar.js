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

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;

const Application = imports.application;
const Manager = imports.manager;

var Searchbar = GObject.registerClass({
    Signals: {
        'activate-result': {}
    }
}, class Searchbar extends Gtk.SearchBar {

    _init() {
        this.searchChangeBlocked = false;

        super._init();

        // subclasses will create this.searchEntry
        let searchWidget = this.createSearchWidget();

        this.add(searchWidget);
        this.connect_entry(this.searchEntry);

        this.searchEntry.connect('search-changed', Lang.bind(this,
            function() {
                if (this.searchChangeBlocked)
                    return;

                this.entryChanged();
            }));

        this.show_all();
    }

    createSearchWidget() {
        log('Error: Searchbar implementations must override createSearchWidget');
    }

    entryChanged() {
        log('Error: Searchbar implementations must override entryChanged');
    }

    handleEvent(event) {
        // Skip if the search bar is shown and the focus is elsewhere
        if (this.search_mode_enabled && !this.searchEntry.is_focus)
            return false;

        let keyval = event.get_keyval()[1];
        if (this.search_mode_enabled && keyval == Gdk.KEY_Return) {
            this.emit('activate-result');
            return true;
        }

        let retval = this.handle_event(event);
        if (retval == Gdk.EVENT_STOP)
            this.searchEntry.grab_focus_without_selecting();
        return retval;
    }

    reveal() {
        this.search_mode_enabled = true;
    }

    conceal() {
        this.search_mode_enabled = false;

        // clear all the search properties when hiding the entry
        this.searchEntry.set_text('');
    }
});

var Dropdown = GObject.registerClass(
    class Dropdown extends Gtk.Popover {

    _init() {
        super._init({ position: Gtk.PositionType.BOTTOM });

        let grid = new Gtk.Grid({ orientation: Gtk.Orientation.HORIZONTAL,
                                  row_homogeneous: true,
                                  visible: true });
        this.add(grid);

        [Application.sourceManager,
         Application.searchTypeManager,
         Application.searchMatchManager].forEach(Lang.bind(this, function(manager) {
             let model = new Manager.BaseModel(manager);

             // HACK: see https://bugzilla.gnome.org/show_bug.cgi?id=733977
             let popover = new Gtk.Popover();
             popover.bind_model(model, 'view');
             let w = popover.get_child();
             w.reparent(grid);
             w.valign = Gtk.Align.START;
             w.vexpand = true;
             popover.destroy();
         }));
    }
});
