/*
 * Copyright (c) 2015 Red Hat, Inc.
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

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;

const _ICON_SIZE = 128;

var ErrorBox = GObject.registerClass(
    class ErrorBox extends Gtk.Grid {

    _init(primary, secondary) {
        super._init({ orientation: Gtk.Orientation.VERTICAL,
                      row_spacing: 12,
                      hexpand: true,
                      vexpand: true,
                      halign: Gtk.Align.CENTER,
                      valign: Gtk.Align.CENTER });

        this._image = new Gtk.Image({ pixel_size: _ICON_SIZE,
                                      icon_name: 'face-uncertain-symbolic',
                                      halign: Gtk.Align.CENTER,
                                      valign: Gtk.Align.CENTER });

        this.add(this._image);

        this._primaryLabel =
            new Gtk.Label({ label: '',
                            use_markup: true,
                            halign: Gtk.Align.CENTER,
                            valign: Gtk.Align.CENTER });
        this.add(this._primaryLabel);

        this._secondaryLabel =
            new Gtk.Label({ label: '',
                            use_markup: true,
                            wrap: true,
                            halign: Gtk.Align.CENTER,
                            valign: Gtk.Align.CENTER });
        this.add(this._secondaryLabel);

        this.show_all();
    }

    update(primary, secondary) {
        let primaryMarkup = '<big><b>' + GLib.markup_escape_text(primary, -1) + '</b></big>';
        let secondaryMarkup = GLib.markup_escape_text(secondary, -1);

        this._primaryLabel.label = primaryMarkup;
        this._secondaryLabel.label = secondaryMarkup;
    }
});
