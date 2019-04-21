/*
 * Copyright (c) 2016 Endless Mobile, Inc.
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
 * Author: Cosimo Cecchi <cosimoc@gnome.org>
 *
 */

const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Lang = imports.lang;

var FullscreenAction = GObject.registerClass({
    Implements: [Gio.Action],
    Properties: {
        'enabled': GObject.ParamSpec.boolean('enabled', 'enabled', 'Whether the action is enabled',
                                             GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                             true),
        'name': GObject.ParamSpec.override('name', Gio.Action),
        'parameter-type': GObject.ParamSpec.override('parameter-type', Gio.Action),
        'state': GObject.ParamSpec.override('state', Gio.Action),
        'state-type': GObject.ParamSpec.override('state-type', Gio.Action),
        'window': GObject.ParamSpec.object('window', 'Window', 'The GtkWindow',
                                           GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                           Gtk.Window.$gtype)
    }
}, class FullscreenAction extends GObject.Object {

    _init(params) {
        this._enabled = true;
        this._fullscreen = false;
        this._window = null;
        this._windowStateId = 0;

        super._init(params);
    }

    _disconnectFromWindow() {
        if (this._windowStateId != 0) {
            this._window.disconnect(this._windowStateId);
            this._windowStateId = 0;
        }
    }

    _connectToWindow() {
        if (this._window) {
            this._windowStateId = this._window.connect('window-state-event',
                                                       Lang.bind(this, this._onWindowStateEvent));
            this._onWindowStateEvent();
        }
    }

    _onWindowStateEvent() {
        let window = this._window.get_window();
        if (!window)
            return;

        let state = window.get_state();
        let fullscreen = (state & Gdk.WindowState.FULLSCREEN);
        if (fullscreen == this._fullscreen)
            return;

        this._fullscreen = fullscreen;
        this.notify('state');
    }

    _changeState(fullscreen) {
        if (!this._window)
            return;

        if (fullscreen)
            this._window.fullscreen();
        else
            this._window.unfullscreen();
    }

    vfunc_activate() {
        this._changeState(!this._fullscreen);
    }

    vfunc_change_state(state) {
        let fullscreen = state.get_boolean();
        this._changeState(fullscreen);
    }

    vfunc_get_enabled() {
        return this.enabled;
    }

    vfunc_get_name() {
        return this.name;
    }

    vfunc_get_parameter_type() {
        return this.parameter_type;
    }

    vfunc_get_state() {
        return this.state;
    }

    vfunc_get_state_hint() {
        return null;
    }

    vfunc_get_state_type() {
        return this.state_type;
    }

    set enabled(v) {
        if (v == this._enabled)
            return;

        this._enabled = v;
        this.notify('enabled');
    }

    get enabled() {
        return this._enabled;
    }

    get name() {
        return 'fullscreen';
    }

    get parameter_type() {
        return null;
    }

    get state() {
        return new GLib.Variant('b', this._fullscreen);
    }

    get state_type() {
        return new GLib.VariantType('b');
    }

    set window(w) {
        if (w == this._window)
            return;

        this._disconnectFromWindow();
        this._window = w;
        this._connectToWindow();

        this.notify('window');
    }

    get window() {
        return this._window;
    }
});
