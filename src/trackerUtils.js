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

const Application = imports.application;

function setEditedName(newTitle, docId, callback) {
    let sparql = ('INSERT OR REPLACE { <%s> nie:title \"%s\" }'.format(docId, newTitle));

    Application.connectionQueue.update(sparql, null,
        function(object, res) {
            try {
                object.update_finish(res);
            } catch (e) {
                logError(e, 'Unable to set the new title on ' + docId + ' to ' + newTitle);
            }

            if (callback)
                callback();
        });

}

var SingleItemJob = GObject.registerClass(
    class SingleItemJob extends GObject.Object {

    _init(urn, queryBuilder) {
        this._urn = urn;
        this._cursor = null;
        this._builder = queryBuilder;
    }

    run(flags, callback) {
        this._callback = callback;

        let query = this._builder.buildSingleQuery(flags, this._urn);
        Application.connectionQueue.add(query.sparql, null, Lang.bind(this,
            function(object, res) {
                try {
                    let cursor = object.query_finish(res);
                    cursor.next_async(null, Lang.bind(this, this._onCursorNext));
                } catch (e) {
                    logError(e, 'Unable to query single item');
                    this._emitCallback();
                }
            }));
    }

    _onCursorNext(cursor, res) {
        let valid = false;

        try {
            valid = cursor.next_finish(res);
        } catch (e) {
            logError(e, 'Unable to query single item');
        }

        if (!valid) {
            cursor.close();
            this._emitCallback();

            return;
        }

        this._cursor = cursor;
        this._emitCallback();
        cursor.close();
    }

    _emitCallback() {
        this._callback(this._cursor);
    }
});
