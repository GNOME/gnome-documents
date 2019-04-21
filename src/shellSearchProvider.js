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
 * Author: Florian Müllner <fmuellner@redhat.com>
 *
 */

const Lang = imports.lang;
const Signals = imports.signals;

const GdPrivate = imports.gi.GdPrivate;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;

const Application = imports.application;
const Query = imports.query;
const TrackerUtils = imports.trackerUtils;
const Utils = imports.utils;

var documentManager = null;
var queryBuilder = null;
var searchMatchManager = null;
var searchTypeManager = null;
var searchController = null;
var sourceManager = null;

const SEARCH_PROVIDER_IFACE = 'org.gnome.Shell.SearchProvider2';
const SEARCH_PROVIDER_PATH  = '/org/gnome/Documents/SearchProvider';

const _SHELL_SEARCH_ICON_SIZE = 128;

const SearchProviderIface = '<node> \
<interface name="org.gnome.Shell.SearchProvider2"> \
<method name="GetInitialResultSet"> \
  <arg type="as" direction="in" /> \
  <arg type="as" direction="out" /> \
</method> \
<method name = "GetSubsearchResultSet"> \
  <arg type="as" direction="in" /> \
  <arg type="as" direction="in" /> \
  <arg type="as" direction="out" /> \
</method> \
<method name = "GetResultMetas"> \
  <arg type="as" direction="in" /> \
  <arg type="aa{sv}" direction="out" /> \
</method> \
<method name = "ActivateResult"> \
  <arg type="s" direction="in" /> \
  <arg type="as" direction="in" /> \
  <arg type="u" direction="in" /> \
</method> \
<method name = "LaunchSearch"> \
  <arg type="as" direction="in" /> \
  <arg type="u" direction="in" /> \
</method> \
</interface> \
</node>';

function _createThumbnailIcon(uri) {
    let file = Gio.file_new_for_uri(uri);

    try {
        let info = file.query_info(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH,
                                   Gio.FileQueryInfoFlags.NONE, null);
        let path = info.get_attribute_byte_string(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH);
        if (path)
            return new Gio.FileIcon({ file: Gio.file_new_for_path(path) });
    } catch(e) {
        logError(e, 'Unable to create thumbnail icon');
    }
    return null;
}

function _createGIcon(cursor) {
    let gicon = null;

    let ident = cursor.get_string(Query.QueryColumns.IDENTIFIER)[0];
    let isRemote = ident && (ident.indexOf('https://docs.google.com') != -1);

    if (!isRemote) {
        let uri = cursor.get_string(Query.QueryColumns.URI)[0];
        if (uri)
            gicon = _createThumbnailIcon(uri);
    }

    if (gicon)
        return gicon;

    let mimetype = cursor.get_string(Query.QueryColumns.MIMETYPE)[0];
    if (mimetype)
        gicon = Gio.content_type_get_icon(mimetype);

    if (gicon)
        return gicon;

    let rdftype = cursor.get_string(Query.QueryColumns.RDFTYPE)[0];
    if (rdftype)
        gicon = Utils.iconFromRdfType(rdftype);

    if (!gicon)
        gicon = new Gio.ThemedIcon({ name: 'text-x-generic' });

    return gicon;
}

const CreateCollectionIconJob = GObject.registerClass(
    class CreateCollectionIconJob extends GObject.Object {

    _init(id) {
        this._id = id;
        this._itemIcons = [];
        this._itemIds = [];
        this._itemJobs = 0;
    }

    run(callback) {
        this._callback = callback;

        let query = queryBuilder.buildCollectionIconQuery(this._id);
        Application.connectionQueue.add(query.sparql, null, Lang.bind(this,
            function(object, res) {
                let cursor = null;

                try {
                    cursor = object.query_finish(res);
                    cursor.next_async(null, Lang.bind(this, this._onCursorNext));
                } catch (e) {
                    logError(e, 'Unable to run CreateCollectionIconJob');
                    this._hasItemIds();
                }
            }));
    }

    _createItemIcon(cursor) {
        let pixbuf = null;
        let icon = _createGIcon(cursor);

        if (icon instanceof Gio.ThemedIcon) {
            let theme = Gtk.IconTheme.get_default();
            let flags = Gtk.IconLookupFlags.FORCE_SIZE;
            let info =
                theme.lookup_by_gicon(icon, _SHELL_SEARCH_ICON_SIZE,
                                      flags);

            try {
                pixbuf = info.load_icon();
            } catch(e) {
                logError(e, 'Unable to load pixbuf');
            }
        } else if (icon instanceof Gio.FileIcon) {
            try {
                let stream = icon.load(_SHELL_SEARCH_ICON_SIZE, null)[0];
                pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream,
                                                          null);
            } catch(e) {
                logError(e, 'Unable to load pixbuf');
            }
        }

        return pixbuf;
    }

    _onCursorNext(cursor, res) {
        let valid = false;

        try {
            valid = cursor.next_finish(res);
        } catch (e) {
            cursor.close();
            logError(e, 'Unable to read results of CreateCollectionIconJob');

            this._hasItemIds();
        }

        if (valid) {
            this._itemIds.push(cursor.get_string(0)[0]);
            cursor.next_async(null, Lang.bind(this, this._onCursorNext));
        } else {
            cursor.close();
            this._hasItemIds();
        }
    }

    _hasItemIds() {
        if (this._itemIds.length == 0) {
            this._returnPixbuf();
            return;
        }

        this._itemIds.forEach(Lang.bind(this,
            function(itemId) {
                let job = new TrackerUtils.SingleItemJob(itemId, queryBuilder);
                this._itemJobs++;
                job.run(Query.QueryFlags.UNFILTERED, Lang.bind(this,
                    function(cursor) {
                        let icon = this._createItemIcon(cursor);
                        if (icon)
                            this._itemIcons.push(icon);
                        this._itemJobCollector();
                    }));
            }));
    }

    _itemJobCollector() {
        this._itemJobs--;

        if (this._itemJobs == 0)
            this._returnPixbuf();
    }

    _returnPixbuf() {
        this._callback(GdPrivate.create_collection_icon(_SHELL_SEARCH_ICON_SIZE, this._itemIcons));
    }
});

const FetchMetasJob = GObject.registerClass(
    class FetchMetasJob extends GObject.Object {

    _init(ids) {
        this._ids = ids;
        this._metas = [];
    }

    _jobCollector() {
        this._activeJobs--;

        if (this._activeJobs == 0)
            this._callback(this._metas);
    }

    _createCollectionPixbuf(meta) {
        let job = new CreateCollectionIconJob(meta.id);
        job.run(Lang.bind(this,
            function(icon) {
                if (icon)
                    meta.icon = icon;

                this._metas.push(meta);
                this._jobCollector();
            }));
    }

    run(callback) {
        this._callback = callback;
        this._activeJobs = this._ids.length;

        this._ids.forEach(Lang.bind(this,
            function(id) {
                let single = new TrackerUtils.SingleItemJob(id, queryBuilder);
                single.run(Query.QueryFlags.UNFILTERED, Lang.bind(this,
                    function(cursor) {
                        let title =    cursor.get_string(Query.QueryColumns.TITLE)[0];
                        let filename = cursor.get_string(Query.QueryColumns.FILENAME)[0];
                        let rdftype =  cursor.get_string(Query.QueryColumns.RDFTYPE)[0];

                        let gicon = null;
                        let pixbuf = null;

                        // Collection
                        let isCollection = (rdftype.indexOf('nfo#DataContainer') != -1);

                        if (!isCollection)
                            gicon = _createGIcon(cursor);

                        if (!title || title == '')
                            title = GdPrivate.filename_strip_extension(filename);

                        if (!title || title == '')
                            title = _("Untitled Document");

                        let meta = { id: id, title: title, icon: gicon };

                        if (isCollection) {
                            this._createCollectionPixbuf(meta);
                        } else {
                            this._metas.push(meta);
                            this._jobCollector();
                        }
                    }));
            }));
    }
});

const FetchIdsJob = GObject.registerClass(
    class FetchIdsJob extends GObject.Object {

    _init(terms) {
        this._terms = terms;
        this._ids = [];
    }

    run(callback, cancellable) {
        this._callback = callback;
        this._cancellable = cancellable;
        searchController.setString(this._terms.join(' '));

        let sortBy = Application.settings.get_enum('sort-by');
        let query = queryBuilder.buildGlobalQuery(Query.QueryFlags.SEARCH, null, sortBy);
        Application.connectionQueue.add(query.sparql, this._cancellable, Lang.bind(this,
            function(object, res) {
                let cursor = null;

                try {
                    cursor = object.query_finish(res);
                    cursor.next_async(this._cancellable, Lang.bind(this, this._onCursorNext));
                } catch (e) {
                    logError(e, 'Unable to run FetchIdsJob');
                    callback(this._ids);
                }
            }));
    }

    _onCursorNext(cursor, res) {
        let valid = false;

        try {
            valid = cursor.next_finish(res);
        } catch (e) {
            cursor.close();
            logError(e, 'Unable to read results of FetchIdsJob');

            this._callback(this._ids);
        }

        if (valid) {
            this._ids.push(cursor.get_string(Query.QueryColumns.URN)[0]);
            cursor.next_async(this._cancellable, Lang.bind(this, this._onCursorNext));
        } else {
            cursor.close();
            this._callback(this._ids);
        }
    }
});

var ShellSearchProvider = GObject.registerClass(
    class ShellSearchProvider extends GObject.Object {

    _init() {
        this._impl = Gio.DBusExportedObject.wrapJSObject(SearchProviderIface, this);
        this._cache = {};
        this._cancellable = new Gio.Cancellable();
    }

    export(connection) {
        return this._impl.export(connection, SEARCH_PROVIDER_PATH);
    }

    unexport(connection) {
        return this._impl.unexport_from_connection(connection);
    }

    _returnMetasFromCache(ids, invocation) {
        let metas = [];
        for (let i = 0; i < ids.length; i++) {
            let id = ids[i];

            if (!this._cache[id])
                continue;

            let meta = { id: GLib.Variant.new('s', this._cache[id].id),
                         name: GLib.Variant.new('s', this._cache[id].title) };

            let icon = this._cache[id].icon;
            meta['icon'] = icon.serialize();
            metas.push(meta);
        }

        Application.application.release();
        invocation.return_value(GLib.Variant.new('(aa{sv})', [ metas ]));
    }

    GetInitialResultSetAsync(params, invocation) {
        let terms = params[0];
        Application.application.hold();

        this._cancellable.cancel();
        this._cancellable.reset();

        let job = new FetchIdsJob(terms);
        job.run(Lang.bind(this,
            function(ids) {
                Application.application.release();
                invocation.return_value(GLib.Variant.new('(as)', [ ids ]));
            }), this._cancellable);
    }

    GetSubsearchResultSetAsync(params, invocation) {
        let [previousResults, terms] = params;
        Application.application.hold();

        this._cancellable.cancel();
        this._cancellable.reset();

        let job = new FetchIdsJob(terms);
        job.run(Lang.bind(this,
            function(ids) {
                Application.application.release();
                invocation.return_value(GLib.Variant.new('(as)', [ ids ]));
            }), this._cancellable);
    }

    GetResultMetasAsync(params, invocation) {
        let ids = params[0];
        Application.application.hold();

        let toFetch = ids.filter(Lang.bind(this,
            function(id) {
                return !(this._cache[id]);
            }));

        if (toFetch.length > 0) {
            let job = new FetchMetasJob(toFetch);
            job.run(Lang.bind(this,
                function(metas) {
                    // cache the newly fetched results
                    metas.forEach(Lang.bind(this,
                        function(meta) {
                            this._cache[meta.id] = meta;
                        }));

                    this._returnMetasFromCache(ids, invocation);
                }));
        } else {
            this._returnMetasFromCache(ids, invocation);
        }
    }

    ActivateResult(id, terms, timestamp) {
        this.emit('activate-result', id, terms, timestamp);
    }

    LaunchSearch(terms, timestamp) {
        this.emit('launch-search', terms, timestamp);
    }
});
Signals.addSignalMethods(ShellSearchProvider.prototype);
