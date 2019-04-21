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

const GdPrivate = imports.gi.GdPrivate;
const Gdk = imports.gi.Gdk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

const Application = imports.application;
const Embed = imports.embed;
const WindowMode = imports.windowMode;

const _ = imports.gettext.gettext;

const _CONFIGURE_ID_TIMEOUT = 100; // msecs
const _WINDOW_MIN_WIDTH = 600;
const _WINDOW_MIN_HEIGHT = 500;

var MainWindow = GObject.registerClass(
    class MainWindow extends Gtk.ApplicationWindow {

    _init(app) {
        this._configureId = 0;

        super._init({ application: app,
                      width_request: _WINDOW_MIN_WIDTH,
                      height_request: _WINDOW_MIN_HEIGHT,
                      window_position: Gtk.WindowPosition.CENTER,
                      show_menubar: false });

        // apply the last saved window size and position
        let size = Application.settings.get_value('window-size');
        if (size.n_children() == 2) {
            let width = size.get_child_value(0);
            let height = size.get_child_value(1);

            this.set_default_size(width.get_int32(), height.get_int32());
        }

        let position = Application.settings.get_value('window-position');
        if (position.n_children() == 2) {
            let x = position.get_child_value(0);
            let y = position.get_child_value(1);

            this.move(x.get_int32(), y.get_int32());
        }

        if (Application.settings.get_boolean('window-maximized'))
            this.maximize();

        this.connect('delete-event', Lang.bind(this, this._quit));
        this.connect('button-press-event', Lang.bind(this, this._onButtonPressEvent));
        this.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        this.connect('configure-event', Lang.bind(this, this._onConfigureEvent));
        this.connect('window-state-event', Lang.bind(this, this._onWindowStateEvent));

        this._embed = new Embed.Embed(this);
        this.add(this._embed);
    }

    _saveWindowGeometry() {
        let window = this.get_window();
        let state = window.get_state();

        if (state & Gdk.WindowState.MAXIMIZED)
            return;

        // GLib.Variant.new() can handle arrays just fine
        let size = this.get_size();
        let variant = GLib.Variant.new ('ai', size);
        Application.settings.set_value('window-size', variant);

        let position = this.get_position();
        variant = GLib.Variant.new ('ai', position);
        Application.settings.set_value('window-position', variant);
    }

    _onConfigureEvent(widget, event) {
        let window = this.get_window();
        let state = window.get_state();

        if (state & Gdk.WindowState.FULLSCREEN)
            return;

        if (this._configureId != 0) {
            Mainloop.source_remove(this._configureId);
            this._configureId = 0;
        }

        this._configureId = Mainloop.timeout_add(_CONFIGURE_ID_TIMEOUT, Lang.bind(this,
            function() {
                this._configureId = 0;
                this._saveWindowGeometry();
                return false;
            }));
    }

    _onWindowStateEvent(widget, event) {
        let window = widget.get_window();
        let state = window.get_state();
        let maximized = (state & Gdk.WindowState.MAXIMIZED);
        Application.settings.set_boolean('window-maximized', maximized);
    }

    _onButtonPressEvent(widget, event) {
        let button = event.get_button()[1];
        let clickCount = event.get_click_count()[1];

        if (clickCount > 1)
            return false;

        // mouse back button
        if (button != 8)
            return false;

        let view = this._embed.view.view;
        let action = view.getAction('go-back');
        if (action) {
            action.activate(null);
            return true;
        }

        return false;
    }

    _onKeyPressEvent(widget, event) {
        let toolbar = this._embed.getMainToolbar();
        return toolbar.handleEvent(event);
    }

    _quit() {
        // remove configure event handler if still there
        if (this._configureId != 0) {
            Mainloop.source_remove(this._configureId);
            this._configureId = 0;
        }

        // always save geometry before quitting
        this._saveWindowGeometry();

        return false;
    }

    showAbout() {
        GdPrivate.show_about_dialog(this);
    }
});
