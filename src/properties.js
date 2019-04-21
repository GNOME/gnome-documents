/*
 * Copyright (c) 2012 Meg Ford
 * Copyright (c) 2012, 2013 Red Hat, Inc.
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
 * Author: Meg Ford <megford@gnome.org>
 *
 */

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Pango = imports.gi.Pango;
const _ = imports.gettext.gettext;
const C_ = imports.gettext.pgettext;

const Application = imports.application;
const Documents = imports.documents;
const Mainloop = imports.mainloop;
const TrackerUtils = imports.trackerUtils;

const Lang = imports.lang;

const _TITLE_ENTRY_TIMEOUT = 200;

var PropertiesDialog = GObject.registerClass(
    class PropertiesDialog extends Gtk.Dialog {

    _init(urn) {
        let doc = Application.documentManager.getItemById(urn);

        let dateModified = GLib.DateTime.new_from_unix_local(doc.mtime);
        let dateModifiedString = dateModified.format('%c');

        let dateCreatedString = null;
        if (doc.dateCreated != -1) {
            let dateCreated = GLib.DateTime.new_from_unix_local(doc.dateCreated);
            dateCreatedString = dateCreated.format('%c');
        }

        let toplevel = Application.application.get_windows()[0];
        super._init({ resizable: false,
                      transient_for: toplevel,
                      modal: true,
                      destroy_with_parent: true,
                      use_header_bar: true,
                      default_width: 400,
                      title: _("Properties"),
                      hexpand: true });

        let grid = new Gtk.Grid ({ orientation: Gtk.Orientation.VERTICAL,
                                   row_homogeneous: true,
                                   column_homogeneous: true,
                                   halign: Gtk.Align.CENTER,
                                   row_spacing: 6,
                                   column_spacing: 24,
                                   margin_top: 12,
                                   margin_start: 24,
                                   margin_end: 24,
                                   margin_bottom: 12 });

        let contentArea = this.get_content_area();
        contentArea.pack_start(grid, true, true, 2);

        // Title item
        // Translators: "Title" is the label next to the document title
        // in the properties dialog
        this._title = new Gtk.Label({ label: C_("Document Title", "Title"),
                                      halign: Gtk.Align.END });
        this._title.get_style_context ().add_class('dim-label');
        grid.add(this._title);

        // Author item
        if (doc.author) {
            // Translators: "Author" is the label next to the document author
            // in the properties dialog
            this._author = new Gtk.Label({ label: C_("Document Author", "Author"),
                                           halign: Gtk.Align.END });
            this._author.get_style_context ().add_class('dim-label');
            grid.add(this._author);
        }

        // Source item
        this._source = new Gtk.Label({ label: _("Source"),
                                       halign: Gtk.Align.END });
        this._source.get_style_context ().add_class('dim-label');
        grid.add (this._source);

        // Date Modified item
        this._dateModified = new Gtk.Label({ label: _("Date Modified"),
                                             halign: Gtk.Align.END });
        this._dateModified.get_style_context ().add_class('dim-label');
        grid.add (this._dateModified);

        // Date Created item
        if (dateCreatedString) {
            this._dateCreated = new Gtk.Label({ label: _("Date Created"),
                                                halign: Gtk.Align.END });
            this._dateCreated.get_style_context ().add_class('dim-label');
            grid.add (this._dateCreated);
        }

        // Document type item
        // Translators: "Type" is the label next to the document type
        // (PDF, spreadsheet, ...) in the properties dialog
        this._docType = new Gtk.Label({ label: C_("Document Type", "Type"),
                                        halign: Gtk.Align.END });
        this._docType.get_style_context ().add_class('dim-label');
        grid.add (this._docType);

        // Title value
        if (doc instanceof Documents.LocalDocument) {
            this._titleEntry = new Gtk.Entry({ activates_default: true,
                                               text: doc.name,
                                               editable: true,
                                               hexpand: true,
                                               width_chars: 40,
                                               halign: Gtk.Align.START });
            grid.attach_next_to (this._titleEntry, this._title, Gtk.PositionType.RIGHT, 2, 1);

            let docId = doc.id;
            this._titleEntryTimeout = 0;

            this._titleEntry.connect('changed', Lang.bind (this,
                function() {
                    if (this._titleEntryTimeout != 0) {
                        Mainloop.source_remove(this._titleEntryTimeout);
                        this._titleEntryTimeout = 0;
                    }

                    this._titleEntryTimeout = Mainloop.timeout_add(_TITLE_ENTRY_TIMEOUT, Lang.bind(this,
                        function() {
                            this._titleEntryTimeout = 0;
                            let newTitle = this._titleEntry.get_text();
                            TrackerUtils.setEditedName(newTitle, docId, null);
                            return false;
                        }));
                }));
        } else {
            this._titleEntry = new Gtk.Label({ label: doc.name,
                                               halign: Gtk.Align.START });
            grid.attach_next_to (this._titleEntry, this._title, Gtk.PositionType.RIGHT, 2, 1);
        }

        // Author value
        if (this._author) {
            this._authorData = new Gtk.Label({ label: doc.author,
                                               halign: Gtk.Align.START });
            grid.attach_next_to (this._authorData, this._author, Gtk.PositionType.RIGHT, 2, 1);
        }

        // Source value
        let [ uri, name ] = doc.getSourceLink();
        if (uri) {
            this._sourceData = new Gtk.Label({ label: '<a href=\"' + uri + '\">' + name + '</a>',
                                               use_markup: true,
                                               halign: Gtk.Align.START,
                                               ellipsize: Pango.EllipsizeMode.END });
        } else {
            // Collections don't have links
            this._sourceData = new Gtk.Label({ label: name,
                                               halign: Gtk.Align.START });
        }

        grid.attach_next_to (this._sourceData, this._source, Gtk.PositionType.RIGHT, 2, 1);

        // Date Modified value
        this._dateModifiedData = new Gtk.Label({ label: dateModifiedString,
                                                 halign: Gtk.Align.START });
        grid.attach_next_to (this._dateModifiedData, this._dateModified, Gtk.PositionType.RIGHT, 2, 1);

        // Date Created value
        if (this._dateCreated) {
            this._dateCreatedData = new Gtk.Label({ label: dateCreatedString,
                                                    halign: Gtk.Align.START });
            grid.attach_next_to (this._dateCreatedData, this._dateCreated, Gtk.PositionType.RIGHT, 2, 1);
        }

        // Document type value
        this._documentTypeData = new Gtk.Label({ label: doc.typeDescription,
                                                 halign: Gtk.Align.START });
        grid.attach_next_to (this._documentTypeData, this._docType, Gtk.PositionType.RIGHT, 2, 1);

        this.show_all();
    }
});
