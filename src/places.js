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
 */

const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const EvDocument = imports.gi.EvinceDocument;
const GdPrivate = imports.gi.GdPrivate;
const Application = imports.application;

const Lang = imports.lang;

var PlacesDialog = GObject.registerClass(
    class PlacesDialog extends Gtk.Dialog {

    _init(model, bookmarks) {
        let toplevel = Application.application.get_windows()[0];
        super._init({ resizable: true,
                      transient_for: toplevel,
                      modal: true,
                      destroy_with_parent: true,
                      use_header_bar: true,
                      default_width: 600, // FIXME use toplevel size
                      default_height: 600,
                      title: "",
                      hexpand: true });

        this._model = model;
        this._bookmarks = bookmarks;
        this._createWindow();
        this.show_all();
    }

    _createWindow() {
        let contentArea = this.get_content_area();
        this._stack = new Gtk.Stack({ border_width: 5,
                                      homogeneous: true });
        contentArea.pack_start(this._stack, true, true, 0);

        let evDoc = this._model.get_document();
        let docHasLinks = false;

        try {
            // This is a hack to find out if evDoc implements the
            // EvDocument.DocumentLinks interface or not.
            docHasLinks = evDoc.has_document_links();
        } catch (e) {
        }

        if (docHasLinks) {
            this._linksPage = new GdPrivate.PlacesLinks();
            this._linksPage.connect('link-activated', Lang.bind(this,
                function(widget, link) {
                    this._handleLink(link);
                }));
            this._addPage(this._linksPage);
        }

        if (this._bookmarks) {
            this._bookmarksPage = new GdPrivate.PlacesBookmarks({ bookmarks: this._bookmarks });
            this._bookmarksPage.connect('bookmark-activated', Lang.bind(this,
                function(widget, link) {
                    this._handleBookmark(link);
                }));
            this._addPage(this._bookmarksPage);
        }

        let pages = this._stack.get_children();
        let header = this.get_header_bar();

        if (pages.length == 1) {
            header.set_title(pages[0].name);
        } else if (pages.length > 1) {
            let switcher = new Gtk.StackSwitcher({ stack: this._stack });
            header.set_custom_title(switcher);
        }
    }

    _handleLink(link) {
        if (link.action.type == EvDocument.LinkActionType.GOTO_DEST) {
            this._gotoDest(link.action.dest);
        }
        this.response(Gtk.ResponseType.DELETE_EVENT);
    }

    _handleBookmark(bookmark) {
        this._model.set_page(bookmark.page_number);
        this.response(Gtk.ResponseType.DELETE_EVENT);
    }

    _gotoDest(dest) {
        switch (dest.type) {
        case EvDocument.LinkDestType.PAGE:
        case EvDocument.LinkDestType.XYZ:
            this._model.set_page(dest.page);
            break;
        case EvDocument.LinkDestType.NAMED:
            let doc = this._model.get_document();
            let dest2 = doc.find_link_dest(dest.named);
            if (dest2)
                this._gotoDest(dest2);
            break;
        case EvDocument.LinkDestType.PAGE_LABEL:
            this._model.set_page_by_label(dest.page_label);
            break;
        }
    }

    _addPage(widget) {
        widget.document_model = this._model;
        this._stack.add_titled(widget, widget.name, widget.name);
    }
});
