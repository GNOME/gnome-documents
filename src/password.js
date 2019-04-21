/*
 * Copyright (c) 2013 Red Hat, Inc.
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
 * Author: Debarshi Ray <debarshir@gnome.org>
 *
 */

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const Application = imports.application;

const Lang = imports.lang;

var PasswordDialog = GObject.registerClass(
    class PasswordDialog extends Gtk.Dialog {

    _init(doc) {
        let toplevel = Application.application.get_windows()[0];
        super._init({ resizable: false,
                      transient_for: toplevel,
                      modal: true,
                      destroy_with_parent: true,
                      use_header_bar: true,
                      default_width: 400,
                      border_width: 6,
                      title: _("Password Required"),
                      hexpand: true });
        this.add_button('gtk-cancel', Gtk.ResponseType.CANCEL);
        this.add_button(_("_Unlock"), Gtk.ResponseType.OK);
        this.set_default_response(Gtk.ResponseType.OK);
        this.set_response_sensitive(Gtk.ResponseType.OK, false);

        let grid = new Gtk.Grid({ column_spacing: 12,
                                  row_spacing: 18,
                                  border_width: 5,
                                  margin_bottom: 6,
                                  hexpand: true,
                                  vexpand: true });

        let contentArea = this.get_content_area();
        contentArea.pack_start(grid, true, true, 2);

        let label;

        let msg = _("Document %s is locked and requires a password to be opened."
                   ).format(doc.name);
        // Doesn't respect halign and hexpand.
        label = new Gtk.Label({ label: msg,
                                max_width_chars: 56,
                                use_markup: true,
                                wrap: true });
        label.set_alignment(0.0, 0.5);
        grid.attach(label, 0, 0, 2, 1);

        let entry = new Gtk.Entry({ activates_default: true,
                                    can_focus: true,
                                    visibility: false,
                                    hexpand: true });
        label = new Gtk.Label({ label: _("_Password"),
                                mnemonic_widget: entry,
                                use_underline: true });
        label.get_style_context().add_class('dim-label');
        grid.attach(label, 0, 1, 1, 1);
        grid.attach(entry, 1, 1, 1, 1);

        entry.connect('realize', Lang.bind(this,
            function() {
                entry.grab_focus();
            }));
        entry.connect('changed', Lang.bind(this,
            function() {
                let length = entry.get_text_length();
                this.set_response_sensitive(Gtk.ResponseType.OK, (length != 0));
            }));

        this.connect('response', Lang.bind(this,
            function(widget, response) {
                if (response != Gtk.ResponseType.OK)
                    return;
                let passwd = entry.get_text();
                Application.documentManager.reloadActiveItem(passwd);
            }));

        this.show_all();
    }
});
