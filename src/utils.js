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

const Gd = imports.gi.Gd;
const GdPrivate = imports.gi.GdPrivate;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;

const Application = imports.application;

const _ICON_VIEW_SIZE = 128;
const _LIST_VIEW_SIZE = 48;

let debugInit = false;
let debugEnabled = false;

function getIconSize() {
    let viewType = Application.settings.get_enum('view-as');

    if (viewType == Gd.MainViewType.LIST)
        return _LIST_VIEW_SIZE;
    else
        return _ICON_VIEW_SIZE;
}

function getThumbnailFrameBorder() {
    let viewType = Application.settings.get_enum('view-as');
    let slice = new Gtk.Border();
    let border = null;

    slice.top = 3;
    slice.right = 3;
    slice.bottom = 6;
    slice.left = 4;

    if (viewType == Gd.MainViewType.LIST) {
        border = new Gtk.Border();
        border.top = 1;
        border.right = 1;
        border.bottom = 3;
        border.left = 2;
    } else {
        border = slice.copy();
    }

    return [ slice, border ];
}

function iconFromRdfType(type) {
    let iconName;

    if (type.indexOf('nfo#Spreadsheet') != -1)
        iconName = 'x-office-spreadsheet';
    else if (type.indexOf('nfo#Presentation') != -1)
        iconName = 'x-office-presentation';
    else if (type.indexOf('nfo#EBook') != -1)
        iconName = 'x-office-document'; //FIXME should be a real icon
    else if (type.indexOf('nfo#DataContainer') != -1)
        return GdPrivate.create_collection_icon(
            getIconSize() * Application.application.getScaleFactor(),
            []);
    else
        iconName = 'x-office-document';

    return new Gio.ThemedIcon({ name: iconName });
}

function getURNsFromPaths(paths, model) {
    return paths.map((path) => {
        return getURNFromPath(path, model);
    });
}

function getURNFromPath(path, model) {
    let iter = model.get_iter(path)[1];
    let id = model.get_value(iter, Gd.MainColumns.ID);

    return id;
}

function debug(str) {
    if (!debugInit) {
        let env = GLib.getenv('DOCUMENTS_DEBUG');
        if (env)
            debugEnabled = true;

        debugInit = true;
    }

    if (debugEnabled)
        log('DEBUG: ' + str);
}

function actionToggleCallback(action) {
    let state = action.get_state();
    action.change_state(GLib.Variant.new('b', !state.get_boolean()));
}

function populateActionGroup(actionGroup, actionEntries, prefix) {
    actionEntries.forEach(function(actionEntry) {
        let settingsKey = actionEntry.settingsKey;
        let state = actionEntry.state;
        let parameterType = actionEntry.parameter_type ?
            GLib.VariantType.new(actionEntry.parameter_type) : null;
        let action;

        if (settingsKey) {
            action = Application.settings.create_action(settingsKey);
        } else {
            if (state)
                action = Gio.SimpleAction.new_stateful(actionEntry.name,
                                                       parameterType, actionEntry.state);
            else
                action = new Gio.SimpleAction({ name: actionEntry.name,
                                                parameter_type: parameterType });
        }

        if (actionEntry.create_hook)
            actionEntry.create_hook(action);

        if (actionEntry.callback)
            action.connect('activate', actionEntry.callback);

        if (actionEntry.stateChanged)
            action.connect('notify::state', actionEntry.stateChanged);

        if (actionEntry.accels)
            Application.application.set_accels_for_action(prefix + '.' + action.name, actionEntry.accels);

        actionGroup.add_action(action);
    });
}

function replaceFile(file, inputStream, cancellable, callback) {
    file.replace_async(
        null, false, Gio.FileCreateFlags.PRIVATE,
        GLib.PRIORITY_DEFAULT, cancellable,
        (object, res) => {
            let outputStream;

            try {
                outputStream = object.replace_finish(res);
            } catch (e) {
                callback(e);
                return;
            }

            outputStream.splice_async(
                inputStream,
                Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET,
                GLib.PRIORITY_DEFAULT, cancellable,
                (object, res) => {
                    try {
                        object.splice_finish(res);
                    } catch (e) {
                        callback(e);
                        return;
                    }

                    callback(null);
                });
        });
}
