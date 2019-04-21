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

const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Signals = imports.signals;

var WindowMode = {
    NONE: 0,
    DOCUMENTS: 1,
    PREVIEW_EV: 2,
    PREVIEW_LOK: 3,
    EDIT: 4,
    COLLECTIONS: 5,
    SEARCH: 6,
};

var ModeController = GObject.registerClass(
    class ModeController extends GObject.Object {

    _init() {
        this._mode = WindowMode.NONE;
        this._history = [];
    }

    goBack(steps) {
        if (!steps)
            steps = 1;

        if (this._history.length < steps)
            return;

        let oldMode;
        for (let i = 0; i < steps; i++)
            oldMode = this._history.pop();

        /* Always go back to the documents view when activated from the search
         * provider. It is easier to special case it here instead of all
         * over the code.
         */
        if (oldMode == WindowMode.NONE && steps == 1)
          oldMode = WindowMode.DOCUMENTS;

        if (oldMode == WindowMode.NONE)
            return;

        // Swap the old and current modes.
        let tmp = oldMode;
        oldMode = this._mode;
        this._mode = tmp;

        this.emit('window-mode-changed', this._mode, oldMode);
    }

    setWindowMode(mode) {
        let oldMode = this._mode;

        if (oldMode == mode)
            return;

        this._history.push(oldMode);
        this._mode = mode;

        this.emit('window-mode-changed', this._mode, oldMode);
    }

    getWindowMode() {
        return this._mode;
    }
});
Signals.addSignalMethods(ModeController.prototype);
