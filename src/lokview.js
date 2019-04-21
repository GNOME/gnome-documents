/*
 * Copyright (c) 2015 Pranav Kant
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
 * Author: Pranav Kant <pranavk@gnome.org>
 *
 */

let LOKDocView;

try {
    LOKDocView = imports.gi.LOKDocView;
} catch(e) {
    // LOKDocView will be undefined, and we'll
    // use this to warn when LO files can't be opened
}

const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const Lang = imports.lang;

const Documents = imports.documents;
const Preview = imports.preview;
const Utils = imports.utils;

const ZOOM_IN_FACTOR = 1.2;
const ZOOM_OUT_FACTOR = (1.0/ZOOM_IN_FACTOR);

const openDocumentFormats = ['application/msword',
                             'application/vnd.ms-excel',
                             'application/vnd.ms-powerpoint',
                             'application/vnd.oasis.opendocument.text',
                             'application/vnd.oasis.opendocument.text-template',
                             'application/vnd.oasis.opendocument.text-web',
                             'application/vnd.oasis.opendocument.text-master',
                             'application/vnd.oasis.opendocument.graphics',
                             'application/vnd.oasis.opendocument.graphics-template',
                             'application/vnd.oasis.opendocument.presentation',
                             'application/vnd.oasis.opendocument.presentation-template',
                             'application/vnd.oasis.opendocument.spreadsheet',
                             'application/vnd.oasis.opendocument.spreadsheet-template',
                             'application/vnd.oasis.opendocument.chart',
                             'application/vnd.oasis.opendocument.formula',
                             'application/vnd.oasis.opendocument.database',
                             'application/vnd.oasis.opendocument.image',
                             'application/vnd.openofficeorg.extension',
                             'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                             'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
                             'application/vnd.openxmlformats-officedocument.presentationml.template',
                             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                             'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
                             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                             'application/vnd.openxmlformats-officedocument.wordprocessingml.template',];

// These are the documents consisting of document parts.
const openDocumentPartFormats = ['application/vnd.ms-excel',
                                 'application/vnd.ms-powerpoint',
                                 'application/vnd.oasis.opendocument.presentation',
                                 'application/vnd.oasis.opendocument.presentation-template',
                                 'application/vnd.oasis.opendocument.spreadsheet',
                                 'application/vnd.oasis.opendocument.spreadsheet-template',
                                 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                                 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
                                 'application/vnd.openxmlformats-officedocument.presentationml.template',
                                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',];

function isAvailable() {
    return (LOKDocView != undefined);
}

function isOpenDocumentPartDocument(mimeType) {
     if (openDocumentPartFormats.indexOf(mimeType) != -1)
         return true;
     return false;
}

function isOpenDocumentFormat(mimeType) {
    if (openDocumentFormats.indexOf(mimeType) != -1)
        return true;
    return false;
}

print('Gjs Value Of Preview.Preview: ' + Preview.Preview);
print('Gjs Value Of Preview.PreviewNavControls: ' + Preview.PreviewNavControls);
print('Gjs Value Of Preview.PreviewToolbar: ' + Preview.PreviewToolbar);
print('Gjs Value Of Preview.PreviewSearchbar: ' + Preview.PreviewSearchbar);
print('Gjs Value Of Preview.PREVIEW_NAVBAR_MARGIN: ' + Preview.PREVIEW_NAVBAR_MARGIN);
print('Preview\'s keys: ' + Object.keys(Preview));
var LOKView = GObject.registerClass(
    class LOKView extends Preview.Preview {

    _init(overlay, mainWindow) {
        super._init(overlay, mainWindow);

        this._progressBar = new Gtk.ProgressBar({ halign: Gtk.Align.FILL,
                                                  valign: Gtk.Align.START });
        this._progressBar.get_style_context().add_class('osd');
        this.overlay.add_overlay(this._progressBar);
    }

    createActions() {
        return [
            { name: 'zoom-in',
              callback: Lang.bind(this, this._zoomIn),
              accels: ['<Primary>plus', '<Primary>equal'] },
            { name: 'zoom-out',
              callback: Lang.bind(this, this._zoomOut),
              accels: ['<Primary>minus'] },
            { name: 'copy',
              callback: Lang.bind(this, this._copy),
              accels: ['<Primary>c'] }
        ];
    }

    createView() {
        let sw = new Gtk.ScrolledWindow({ hexpand: true,
                                          vexpand: true });
        sw.get_style_context().add_class('documents-scrolledwin');

        if (isAvailable()) {
            this._lokview = LOKDocView.View.new(null, null);
            sw.add(this._lokview);

            this._lokview.show();
            this._lokview.connect('button-press-event', Lang.bind(this, this._onButtonPressEvent));
            this._lokview.connect('load-changed', Lang.bind(this, this._onProgressChanged));
            this._lokview.connect('text-selection', Lang.bind(this, this._onTextSelection));
            this._lokview.connect('notify::can-zoom-in', Lang.bind(this, this._onCanZoomInChanged));
            this._lokview.connect('notify::can-zoom-out', Lang.bind(this, this._onCanZoomOutChanged));
        }

        return sw;
    }

    onLoadFinished(manager, doc) {
        super.onLoadFinished(manager, doc);

        if (!isAvailable())
            return;
        this._doc = doc;
        this._lokview.open_document(doc.uriToLoad, '{}', null, Lang.bind(this, this._onDocumentOpened));
        this._progressBar.show();
    }

    _onDocumentOpened(res, doc) {
        // TODO: Call _finish and check failure
        this._progressBar.hide();
        this.set_visible_child_name('view');
        this._lokview.set_edit(false);
    }

    _copy() {
        let [selectedText, mimeType] = this._lokview.copy_selection('text/plain;charset=utf-8');
        let display = Gdk.Display.get_default();
        let clipboard = Gtk.Clipboard.get_default(display);

        clipboard.set_text(selectedText, selectedText.length);
    }

    _zoomIn() {
        // FIXME: https://bugs.documentfoundation.org/show_bug.cgi?id=97301
        if (!this._doc)
            return;
        let zoomLevel = this._lokview.get_zoom() * ZOOM_IN_FACTOR;
        this._lokview.set_zoom(zoomLevel);
    }

    _zoomOut() {
        // FIXME: https://bugs.documentfoundation.org/show_bug.cgi?id=97301
        if (!this._doc)
            return;
        let zoomLevel = this._lokview.get_zoom() * ZOOM_OUT_FACTOR;
        this._lokview.set_zoom(zoomLevel);
    }

    _onCanZoomInChanged() {
        this.getAction('zoom-in').enabled = this._lokview.can_zoom_in;
    }

    _onCanZoomOutChanged() {
        this.getAction('zoom-out').enabled = this._lokview.can_zoom_out;
    }

    _onButtonPressEvent(widget, event) {
        let button = event.get_button()[1];

        if (button == 3) {
            let time = event.get_time();
            this.contextMenu.popup(null, null, null, button, time);
            return true;
        }

        return false;
    }

    _onProgressChanged() {
        this._progressBar.fraction = this._lokview.load_progress;
    }

    _onTextSelection(hasSelection) {
        this.getAction('copy').enabled = hasSelection;
    }

    goPrev() {
        let currentPart = this._lokview.get_part();
        currentPart -= 1;
        if (currentPart < 0)
            return;
        this._lokview.set_part(currentPart);
        // FIXME: https://bugs.documentfoundation.org/show_bug.cgi?id=97236
        this._lokview.reset_view();
    }

    goNext() {
        let totalParts  = this._lokview.get_parts();
        let currentPart = this._lokview.get_part();
        currentPart += 1;
        if (currentPart > totalParts)
            return;
        this._lokview.set_part(currentPart);
        // FIXME: https://bugs.documentfoundation.org/show_bug.cgi?id=97236
        this._lokview.reset_view();
    }

    get hasPages() {
        return this._doc ? isOpenDocumentPartDocument(this._doc.mimeType) : false;
    }

    get page() {
        return this._lokview.get_part();
    }

    get numPages() {
        return this._lokview.get_parts();
    }
});
