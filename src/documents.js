/*
 * Copyright (c) 2011, 2012, 2013, 2014 Red Hat, Inc.
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

const EvDocument = imports.gi.EvinceDocument;
const EvView = imports.gi.EvinceView;
const LOKView = imports.lokview;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const Gd = imports.gi.Gd;
const GdPrivate = imports.gi.GdPrivate;
const Gdk = imports.gi.Gdk;
const GData = imports.gi.GData;
const GLib = imports.gi.GLib;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Gtk = imports.gi.Gtk;
const Zpj = imports.gi.Zpj;
const _ = imports.gettext.gettext;

const Mainloop = imports.mainloop;
const Signals = imports.signals;

const Application = imports.application;
const ChangeMonitor = imports.changeMonitor;
const Manager = imports.manager;
const Notifications = imports.notifications;
const Query = imports.query;
const Search = imports.search;
const TrackerUtils = imports.trackerUtils;
const Utils = imports.utils;
const WindowMode = imports.windowMode;

const DeleteItemJob = class DeleteItemJob {
    // deletes the given resource
    constructor(urn) {
        this._urn = urn;
    }

    run(callback) {
        this._callback = callback;

        let query = Application.queryBuilder.buildDeleteResourceQuery(this._urn);
        Application.connectionQueue.update(query.sparql, null, (object, res) => {
            try {
                object.update_finish(res);
            } catch (e) {
                logError(e, 'Failed to delete resource ' + this._urn);
            }

            if (this._callback)
                this._callback();
        });
    }
}

const CollectionIconWatcher = class CollectionIconWatcher {
    constructor(collection) {
        this._collection = collection;
        this._pixbuf = null;

        this._start();
    }

    _clear() {
        this._docConnections = {};
        this._urns = [];
        this._docs = [];
    }

    _start() {
        this._clear();

        let query = Application.queryBuilder.buildCollectionIconQuery(this._collection.id);
        Application.connectionQueue.add(query.sparql, null, (object, res) => {
            let cursor = null;
            try {
                cursor = object.query_finish(res);
            } catch (e) {
                logError(e, 'Unable to query collection items');
                return;
            }

            cursor.next_async(null, this._onCursorNext.bind(this));
        });
    }

    _onCursorNext(cursor, res) {
        let valid = false;

        try {
            valid = cursor.next_finish(res);
        } catch (e) {
            logError(e, 'Unable to query collection items');
            cursor.close();
            return;
        }

        if (!valid) {
            cursor.close();
            this._onCollectionIconFinished();

            return;
        }

        let urn = cursor.get_string(0)[0];
        this._urns.push(urn);

        cursor.next_async(null, this._onCursorNext.bind(this));
    }

    _onCollectionIconFinished() {
        if (!this._urns.length)
            return;

        // now this._urns has all the URNs of items contained in the collection
        let toQuery = [];

        this._urns.forEach((urn) => {
            let doc = Application.documentManager.getItemById(urn);
            if (doc)
                this._docs.push(doc);
            else
                toQuery.push(urn);
        });

        this._toQueryRemaining = toQuery.length;
        if (!this._toQueryRemaining) {
            this._allDocsReady();
            return;
        }

        toQuery.forEach((urn) => {
            let job = new TrackerUtils.SingleItemJob(urn, Application.queryBuilder);
            job.run(Query.QueryFlags.UNFILTERED, (cursor) => {
                if (cursor) {
                    let doc = Application.documentManager.createDocumentFromCursor(cursor);
                    this._docs.push(doc);
                }

                this._toQueryCollector();
            });
        });
    }

    _toQueryCollector() {
        this._toQueryRemaining--;

        if (!this._toQueryRemaining)
            this._allDocsReady();
    }

    _allDocsReady() {
        this._docs.forEach((doc) => {
            let updateId = doc.connect('info-updated', this._createCollectionIcon.bind(this));
            this._docConnections[updateId] = doc;
        });

        this._createCollectionIcon();
    }

    _createCollectionIcon() {
        // now this._docs has an array of Document objects from which we will create the
        // collection icon
        let pixbufs = [];

        this._docs.forEach((doc) => {
            if (doc.origPixbuf) {
                if (doc._thumbPath && !doc._failedThumbnailing)
                    doc.origPixbuf.set_option('-documents-has-thumb', 'true');
                else
                    doc.origPixbuf.remove_option('-documents-has-thumb');
                pixbufs.push(doc.origPixbuf);
            }
        });

        this._pixbuf = GdPrivate.create_collection_icon(
            Utils.getIconSize() * Application.application.getScaleFactor(),
            pixbufs);
        this._emitRefresh();
    }

    _emitRefresh() {
        this.emit('icon-updated', this._pixbuf);
    }

    destroy() {
        for (let id in this._docConnections) {
            let doc = this._docConnections[id];
            doc.disconnect(id);
        }
    }

    refresh() {
        this.destroy();
        this._start();
    }
}
Signals.addSignalMethods(CollectionIconWatcher.prototype);

const DocCommon = class DocCommon {
    constructor(cursor) {
        this.id = null;
        this.uri = null;
        this.uriToLoad = null;
        this.filename = null;
        this.name = null;
        this.author = null;
        this.mtime = null;
        this.resourceUrn = null;
        this.surface = null;
        this.origPixbuf = null;
        this.defaultApp = null;
        this.defaultAppName = null;

        this.mimeType = null;
        this.rdfType = null;
        this.dateCreated = null;
        this.typeDescription = null;
        this.sourceName = null;

        this.rowRefs = {};
        this.shared = false;

        this.collection = false;
        this._collectionIconWatcher = null;

        this._thumbPath = null;

        this.populateFromCursor(cursor);

        this._refreshIconId =
            Application.settings.connect('changed::view-as', this.refreshIcon.bind(this));
    }

    refresh() {
        let job = new TrackerUtils.SingleItemJob(this.id, Application.queryBuilder);
        job.run(Query.QueryFlags.NONE, (cursor) => {
            if (!cursor)
                return;

            this.populateFromCursor(cursor);
        });
    }

    _sanitizeTitle() {
        this.name = this.name.replace(/Microsoft Word - /g, '');
    }

    populateFromCursor(cursor) {
        this.uri = cursor.get_string(Query.QueryColumns.URI)[0];
        this.id = cursor.get_string(Query.QueryColumns.URN)[0];
        this.identifier = cursor.get_string(Query.QueryColumns.IDENTIFIER)[0];
        this.author = cursor.get_string(Query.QueryColumns.AUTHOR)[0];
        this.resourceUrn = cursor.get_string(Query.QueryColumns.RESOURCE_URN)[0];

        let mtime = cursor.get_string(Query.QueryColumns.MTIME)[0];
        if (mtime) {
            let timeVal = GLib.time_val_from_iso8601(mtime)[1];
            this.mtime = timeVal.tv_sec;
        } else {
            this.mtime = Math.floor(GLib.get_real_time() / 1000000);
        }

        this.mimeType = cursor.get_string(Query.QueryColumns.MIMETYPE)[0];
        this.rdfType = cursor.get_string(Query.QueryColumns.RDFTYPE)[0];
        this._updateInfoFromType();

        let dateCreated = cursor.get_string(Query.QueryColumns.DATE_CREATED)[0];
        if (dateCreated) {
            let timeVal = GLib.time_val_from_iso8601(dateCreated)[1];
            this.dateCreated = timeVal.tv_sec;
        } else {
            this.dateCreated = -1;
        }

        // sanitize
        if (!this.uri)
            this.uri = '';

        let title = cursor.get_string(Query.QueryColumns.TITLE)[0];
        this.filename = cursor.get_string(Query.QueryColumns.FILENAME)[0];

        if (title && title != '')
            this.name = title;
        else if (this.filename)
            this.name = GdPrivate.filename_strip_extension(this.filename);
        else
            this.name = '';

        this._sanitizeTitle();

        this.refreshIcon();
    }

    updateIconFromType() {
        let icon = null;

        if (this.mimeType)
            icon = Gio.content_type_get_icon(this.mimeType);

        if (!icon)
            icon = Utils.iconFromRdfType(this.rdfType);

        let iconInfo =
            Gtk.IconTheme.get_default().lookup_by_gicon_for_scale(icon, Utils.getIconSize(),
                                                                  Application.application.getScaleFactor(),
                                                                  Gtk.IconLookupFlags.FORCE_SIZE);

        let pixbuf = null;
        if (iconInfo != null) {
            try {
                pixbuf = iconInfo.load_icon();
                this._setOrigPixbuf(pixbuf);
            } catch (e) {
                logError(e, 'Unable to load pixbuf');
            }
        }
    }

    _refreshCollectionIcon() {
        if (!this._collectionIconWatcher) {
            this._collectionIconWatcher = new CollectionIconWatcher(this);

            this._collectionIconWatcher.connect('icon-updated', (watcher, pixbuf) => {
                this._setOrigPixbuf(pixbuf);
            });
        } else {
            this._collectionIconWatcher.refresh();
        }
    }

    download(useCache, cancellable, callback) {
        let localFile = Gio.File.new_for_uri(this.uriToLoad);
        let localPath = localFile.get_path();
        let localDir = GLib.path_get_dirname(localPath);
        GLib.mkdir_with_parents(localDir, 448);

        if (!useCache) {
            Utils.debug('Downloading ' + this.constructor.name + ' ' + this.id + ' to ' + this.uriToLoad +
                        ': bypass cache ');
            this.downloadImpl(localFile, cancellable, callback);
            return;
        }

        localFile.query_info_async(
            Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (object, res) => {
                let info;

                try {
                    info = object.query_info_finish(res);
                } catch (e) {
                    Utils.debug('Downloading ' + this.constructor.name + ' ' + this.id + ' to ' + this.uriToLoad +
                                ': cache miss');
                    this.downloadImpl(localFile, cancellable, callback);
                    return;
                }

                let cacheMtime = info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED);
                if (this.mtime <= cacheMtime) {
                    callback(true, null);
                    return;
                }

                Utils.debug('Downloading ' + this.constructor.name + ' ' + this.id + ' to ' + this.uriToLoad +
                            ': cache stale (' + this.mtime + ' > ' + cacheMtime + ')');
                this.downloadImpl(localFile, cancellable, callback);
            });
    }

    downloadImpl(localFile, cancellable, callback) {
        throw(new Error('DocCommon implementations must override downloadImpl'));
    }

    load(passwd, cancellable, callback) {
        Utils.debug('Loading ' + this.constructor.name + ' ' + this.id);

        if (this.collection) {
            Mainloop.idle_add(() => {
                let error = new GLib.Error(Gio.IOErrorEnum,
                                           Gio.IOErrorEnum.NOT_SUPPORTED,
                                           "Collections can't be loaded");
                callback(this, null, error);
                return GLib.SOURCE_REMOVE;
            });

            return;
        }

        this.download(true, cancellable, (fromCache, error) => {
            if (error) {
                callback(this, null, error);
                return;
            }

            this.loadLocal(passwd, cancellable, (doc, docModel, error) => {
                if (error) {
                    if (fromCache &&
                        !error.matches(EvDocument.DocumentError, EvDocument.DocumentError.ENCRYPTED)) {
                        this.download(false, cancellable, (fromCache, error) => {
                            if (error) {
                                callback(this, null, error);
                                return;
                            }

                            this.loadLocal(passwd, cancellable, callback);
                        });
                    } else {
                        callback(this, null, error);
                    }

                    return;
                }

                callback(this, docModel, null);
            });
        });
    }

    canEdit() {
        throw(new Error('DocCommon implementations must override canEdit'));
    }

    canEditTitle() {
        return false;
    }

    canShare() {
        throw(new Error('DocCommon implementations must override canShare'));
    }

    canTrash() {
        throw(new Error('DocCommon implementations must override canTrash'));
    }

    canPrint(docModel) {
        if (this.collection)
            return false;

        if (!docModel)
            return false;

        return EvView.PrintOperation.exists_for_document(docModel.get_document());
    }

    trash() {
        if (!this.canTrash())
            return;

        this.trashImpl();

        let job = new DeleteItemJob(this.id);
        job.run(null);
    }

    trashImpl() {
        throw(new Error('DocCommon implementations must override trashImpl'));
    }

    createThumbnail(callback) {
        throw(new Error('DocCommon implementations must override createThumbnail'));
    }

    refreshIcon() {
        if (this._thumbPath) {
            this._refreshThumbPath();
            return;
        }

        this.updateIconFromType();

        if (this.collection) {
            this._refreshCollectionIcon();
            return;
        }

        if (this._failedThumbnailing)
            return;

        this._file = Gio.file_new_for_uri(this.uri);
        this._file.query_info_async(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH,
                                    Gio.FileQueryInfoFlags.NONE,
                                    GLib.PRIORITY_DEFAULT,
                                    null,
                                    this._onFileQueryInfo.bind(this));
    }

    _onFileQueryInfo(object, res) {
        let info = null;
        let haveNewIcon = false;

        try {
            info = object.query_info_finish(res);
        } catch (e) {
            logError(e, 'Unable to query info for file at ' + this.uri);
            this._failedThumbnailing = true;
            return;
        }

        this._thumbPath = info.get_attribute_byte_string(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH);
        if (this._thumbPath) {
            this._refreshThumbPath();
        } else {
            this.createThumbnail(this._onCreateThumbnail.bind(this));
        }
    }

    _onCreateThumbnail(thumbnailed) {
        if (!thumbnailed) {
            this._failedThumbnailing = true;
            return;
        }

        // get the new thumbnail path
        this._file.query_info_async(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH,
                                    Gio.FileQueryInfoFlags.NONE,
                                    GLib.PRIORITY_DEFAULT,
                                    null,
                                    this._onThumbnailPathInfo.bind(this));
    }

    _onThumbnailPathInfo(object, res) {
        let info = null;

        try {
            info = object.query_info_finish(res);
        } catch (e) {
            logError(e, 'Unable to query info for file at ' + this.uri);
            this._failedThumbnailing = true;
            return;
        }

        this._thumbPath = info.get_attribute_byte_string(Gio.FILE_ATTRIBUTE_THUMBNAIL_PATH);
        if (this._thumbPath)
            this._refreshThumbPath();
        else
            this._failedThumbnailing = true;
    }

    _refreshThumbPath() {
        let thumbFile = Gio.file_new_for_path(this._thumbPath);

        thumbFile.read_async(GLib.PRIORITY_DEFAULT, null, (object, res) => {
            let stream;

            try {
                stream = object.read_finish(res);
            } catch (e) {
                logError(e, 'Unable to read file at ' + thumbFile.get_uri());
                this._failedThumbnailing = true;
                this._thumbPath = null;
                thumbFile.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                return;
            }

            let scale = Application.application.getScaleFactor();
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
                stream,
                Utils.getIconSize() * scale, Utils.getIconSize() * scale,
                true, null, (object, res) => {
                    // close the underlying stream immediately
                    stream.close_async(0, null, null);

                    let pixbuf;

                    try {
                        pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
                    } catch (e) {
                        if (!e.matches(GdkPixbuf.PixbufError, GdkPixbuf.PixbufError.UNKNOWN_TYPE))
                            logError(e, 'Unable to create pixbuf from ' + thumbFile.get_uri());

                        this._failedThumbnailing = true;
                        this._thumbPath = null;
                        thumbFile.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                        return;
                    }

                    this._setOrigPixbuf(pixbuf);
                });
        });
    }

    _updateInfoFromType() {
        if (this.rdfType.indexOf('nfo#DataContainer') != -1)
            this.collection = true;

        this.updateTypeDescription();
    }

    _createSymbolicEmblem(name) {
        let pix = Gd.create_symbolic_icon(name, Utils.getIconSize() *
                                          Application.application.getScaleFactor());

        if (!pix)
            pix = new Gio.ThemedIcon({ name: name });

        return pix;
    }

    _setOrigPixbuf(pixbuf) {
        if (pixbuf) {
            this.origPixbuf = pixbuf;
        }

        this._checkEffectsAndUpdateInfo();
    }

    _checkEffectsAndUpdateInfo() {
        if (!this.origPixbuf)
            return;

        let emblemIcons = [];
        let emblemedPixbuf = this.origPixbuf;

        if (this.shared)
            emblemIcons.push(this._createSymbolicEmblem('emblem-shared'));

        if (emblemIcons.length > 0) {
            let emblemedIcon = new Gio.EmblemedIcon({ gicon: this.origPixbuf });

            emblemIcons.forEach(
                function(emblemIcon) {
                    let emblem = new Gio.Emblem({ icon: emblemIcon });
                    emblemedIcon.add_emblem(emblem);
                });

            let theme = Gtk.IconTheme.get_default();

            try {
                let iconInfo = theme.lookup_by_gicon(emblemedIcon,
                                                     Math.max(this.origPixbuf.get_width(),
                                                              this.origPixbuf.get_height()),
                                                     Gtk.IconLookupFlags.FORCE_SIZE);

                emblemedPixbuf = iconInfo.load_icon();
            } catch (e) {
                logError(e, 'Unable to render the emblem');
            }
        }

        let thumbnailedPixbuf = null;

        if (this._thumbPath) {
            let [ slice, border ] = Utils.getThumbnailFrameBorder();
            thumbnailedPixbuf = Gd.embed_image_in_frame(emblemedPixbuf,
                'resource:///org/gnome/Documents/ui/thumbnail-frame.png',
                slice, border);
        } else {
            thumbnailedPixbuf = emblemedPixbuf;
        }

        this.surface = Gdk.cairo_surface_create_from_pixbuf(thumbnailedPixbuf,
            Application.application.getScaleFactor(),
            Application.application.getGdkWindow());

        this.emit('info-updated');
    }

    destroy() {
        if (this._collectionIconWatcher) {
            this._collectionIconWatcher.destroy();
            this._collectionIconWatcher = null;
        }

        Application.settings.disconnect(this._refreshIconId);
    }

    loadLocal(passwd, cancellable, callback) {
        Utils.debug('Loading ' + this.constructor.name + ' ' + this.id + ' from ' + this.uriToLoad);

        if (LOKView.isOpenDocumentFormat(this.mimeType)) {
            let exception = null;
            if (!LOKView.isAvailable()) {
                exception = new GLib.Error(Gio.IOErrorEnum,
                                           Gio.IOErrorEnum.NOT_SUPPORTED,
                                           "Internal error: LibreOffice isn't available");
            }
            callback (this, null, exception);
            return;
        }

        GdPrivate.pdf_loader_load_uri_async(this.uriToLoad, passwd, cancellable, (source, res) => {
            try {
                let docModel = GdPrivate.pdf_loader_load_uri_finish(res);
                callback(this, docModel, null);
            } catch (e) {
                callback(this, null, e);
            }
        });
    }

    open(parent, timestamp) {
        if (!this.defaultAppName)
            return;

        // Without a defaultApp, launch in the web browser,
        // otherwise use that system application
        try {
            if (this.defaultApp)
                this.defaultApp.launch_uris( [ this.uri ], null);
            else
                Gtk.show_uri_on_window(parent, this.uri, timestamp);
        } catch (e) {
            logError(e, 'Unable to show URI ' + this.uri);
        }
    }

    print(toplevel) {
        this.load(null, null, (doc, docModel, error) => {
            if (error) {
                logError(error, 'Unable to print document ' + this.uri);
                return;
            }

            if (!this.canPrint(docModel))
                return;

            let printOp = EvView.PrintOperation.new(docModel.get_document());

            printOp.connect('begin-print', () => {
                this.emit('begin-print');
            });

            printOp.connect('done', (op, res) => {
                if (res == Gtk.PrintOperationResult.ERROR) {
                    try {
                        printOp.get_error();
                    } catch (e) {
                        let errorDialog = new Gtk.MessageDialog ({ transient_for: toplevel,
                                                                   modal: true,
                                                                   destroy_with_parent: true,
                                                                   buttons: Gtk.ButtonsType.OK,
                                                                   message_type: Gtk.MessageType.ERROR,
                                                                   text: _("Failed to print document"),
                                                                   secondary_text: e.message });
                        errorDialog.connect ('response', () => {
                            errorDialog.destroy();
                        });
                        errorDialog.show();
                    }
                }
            });

            let printNotification = new Notifications.PrintNotification(printOp, doc);

            printOp.run(toplevel);
        });
    }

    getSourceLink() {
        // This should return an array of URI and source name
        log('Error: DocCommon implementations must override getSourceLink');
    }

    getWhere() {
        let retval = '';

        if (this.collection)
            retval = '{ ?urn nie:isPartOf <' + this.id + '> }';

        return retval;
    }
}
Signals.addSignalMethods(DocCommon.prototype);

var LocalDocument = class LocalDocument extends DocCommon {
    constructor(cursor) {
        super(cursor);

        this._failedThumbnailing = false;
        this.sourceName = _("Local");

        if (this.mimeType) {
            let defaultApp = Gio.app_info_get_default_for_type(this.mimeType, true);
            let recommendedApp = null;

            let apps = Gio.app_info_get_recommended_for_type (this.mimeType);
            for (let i = 0; i < apps.length; i++) {
                if (apps[i].supports_uris ()) {
                    // Never offer to open in an archive handler
                    if (apps[i].get_id() == 'org.gnome.FileRoller.desktop')
                        continue;
                    if (defaultApp && apps[i].equal (defaultApp)) {
                        // Found the recommended app that's also the default
                        recommendedApp = apps[i];
                        break;
                    }
                    // Set the first recommendedApp as the default if
                    // they don't match
                    if (!recommendedApp)
                        recommendedApp = apps[i];
                }
            }

            this.defaultApp = recommendedApp;
        }

        if (this.defaultApp)
            this.defaultAppName = this.defaultApp.get_name();
    }

    populateFromCursor(cursor) {
        super.populateFromCursor(cursor);
        this.uriToLoad = this.uri;

        if (!Application.application.gettingStartedLocation)
            return;

        let file = Gio.File.new_for_uri(this.uri);
        if (file.has_parent(Application.application.gettingStartedLocation)) {
            // Translators: Documents ships a "Getting Started with Documents"
            // tutorial PDF. The "GNOME" string below is displayed as the author name
            // of that document, and doesn't normally need to be translated.
            this.author = _("GNOME");
            this.name = this.title = _("Getting Started with Documents");
        }
    }

    createThumbnail(callback) {
        GdPrivate.queue_thumbnail_job_for_file_async(this._file, (object, res) => {
            let thumbnailed = false;

            try {
                thumbnailed = GdPrivate.queue_thumbnail_job_for_file_finish(res);
            } catch (e) {
                /* We don't care about reporting errors here, just fail the
                 * thumbnail.
                 */
            }

            callback(thumbnailed);
        });
    }

    updateTypeDescription() {
        let description = '';

        if (this.collection)
            description = _("Collection");
        else if (this.mimeType)
            description = Gio.content_type_get_description(this.mimeType);

        this.typeDescription = description;
    }

    downloadImpl(localFile, cancellable, callback) {
        throw(new Error('LocalDocuments need not be downloaded'));
    }

    load(passwd, cancellable, callback) {
        Utils.debug('Loading ' + this.constructor.name + ' ' + this.id);

        if (this.collection) {
            Mainloop.idle_add(() => {
                let error = new GLib.Error(Gio.IOErrorEnum,
                                           Gio.IOErrorEnum.NOT_SUPPORTED,
                                           "Collections can't be loaded");
                callback(this, null, error);
                return GLib.SOURCE_REMOVE;
            });

            return;
        }

        this.loadLocal(passwd, cancellable, callback);
    }

    canEdit() {
        return this.collection;
    }

    canEditTitle() {
        return true;
    }

    canShare() {
        return false;
    }

    canTrash() {
        return true;
    }

    trashImpl() {
        if (this.collection)
            return;

        let file = Gio.file_new_for_uri(this.uri);
        file.trash_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            try {
                file.trash_finish(res);
            } catch(e) {
                logError(e, 'Unable to trash ' + this.uri);
            }
        });
    }

    getSourceLink() {
        if (this.collection)
            return [ null, this.sourceName ];

        let sourceLink = Gio.file_new_for_uri(this.uri).get_parent();
        let sourcePath = sourceLink.get_path();

        let uri = sourceLink.get_uri();
        return [ uri, sourcePath ];
    }
}

const GOOGLE_PREFIX = 'google:drive:';

const GoogleDocument = class GoogleDocument extends DocCommon {
    constructor(cursor) {
        super(cursor);

        this._failedThumbnailing = false;

        // overridden
        this.defaultAppName = _("Google Docs");
        this.sourceName = _("Google");
    }

    createGDataEntry(cancellable, callback) {
        let source = Application.sourceManager.getItemById(this.resourceUrn);

        let authorizer = new GData.GoaAuthorizer({ goa_object: source.object });
        let service = new GData.DocumentsService({ authorizer: authorizer });
        let gdata_id = this.identifier.substring(GOOGLE_PREFIX.length);

        service.query_single_entry_async
            (GData.DocumentsService.get_primary_authorization_domain(),
             gdata_id, null,
             GData.DocumentsText,
             cancellable,
             (object, res) => {
                 let entry = null;
                 let exception = null;

                 try {
                     entry = object.query_single_entry_finish(res);
                 } catch (e) {
                     exception = e;
                 }

                 callback(entry, service, exception);
             });
    }

    downloadImpl(localFile, cancellable, callback) {
        this.createGDataEntry(cancellable, (entry, service, error) => {
            if (error) {
                callback(false, error);
                return;
            }

            Utils.debug('Created GDataEntry for ' + this.id);

            let inputStream;

            try {
                inputStream = entry.download(service, 'pdf', cancellable);
            } catch(e) {
                callback(false, e);
                return;
            }

            Utils.replaceFile(localFile, inputStream, cancellable, (error) => {
                callback(false, error);
            });
        });
    }

    createThumbnail(callback) {
        this.createGDataEntry(null, (entry, service, exception) => {
            if (exception) {
                callback(false);
                return;
            }

            let uri = entry.get_thumbnail_uri();
            if (!uri) {
                callback(false);
                return;
            }

            let authorizationDomain = GData.DocumentsService.get_primary_authorization_domain();
            let inputStream = new GData.DownloadStream({ service: service,
                                                         authorization_domain: authorizationDomain,
                                                         download_uri: uri });

            let path = GnomeDesktop.desktop_thumbnail_path_for_uri (this.uri,
                                                                    GnomeDesktop.DesktopThumbnailSize.NORMAL);
            let dirPath = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dirPath, 448);

            let downloadFile = Gio.File.new_for_path(path);
            Utils.replaceFile(downloadFile, inputStream, null, (error) => {
                callback(!!error);
            });
        });
    }

    updateTypeDescription() {
        let description;

        if (this.collection)
            description = _("Collection");
        else if (this.rdfType.indexOf('nfo#Spreadsheet') != -1)
            description = _("Spreadsheet");
        else if (this.rdfType.indexOf('nfo#Presentation') != -1)
            description = _("Presentation");
        else
            description = _("Document");

        this.typeDescription = description;
    }

    populateFromCursor(cursor) {
        this.shared = cursor.get_boolean(Query.QueryColumns.SHARED);

        super.populateFromCursor(cursor);

        let localDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gnome-documents", "google"]);

        let identifierHash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, this.identifier, -1);
        let localFilename = identifierHash + ".pdf";

        let localPath = GLib.build_filenamev([localDir, localFilename]);
        let localFile = Gio.File.new_for_path(localPath);
        this.uriToLoad = localFile.get_uri();
    }

    canEdit() {
        return !this.collection;
    }

    canShare() {
        return true;
    }

    canTrash() {
        return false;
    }

    getSourceLink() {
        let uri = 'http://docs.google.com/';
        return [ uri, this.sourceName ];
    }
}

const OWNCLOUD_PREFIX = 'owncloud:';

const OwncloudDocument = class OwncloudDocument extends DocCommon {
    constructor(cursor) {
        super(cursor);

        this._failedThumbnailing = true;

        // overridden
        this.sourceName = _("ownCloud");

        if (this.mimeType)
            this.defaultApp = Gio.app_info_get_default_for_type(this.mimeType, true);

        if (this.defaultApp)
            this.defaultAppName = this.defaultApp.get_name();
    }

    populateFromCursor(cursor) {
        super.populateFromCursor(cursor);

        let localDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gnome-documents", "owncloud"]);

        let identifierHash = this.identifier.substring(OWNCLOUD_PREFIX.length);
        let filenameStripped = GdPrivate.filename_strip_extension(this.filename);
        let extension = this.filename.substring(filenameStripped.length);
        let localFilename = identifierHash + extension;

        let localPath = GLib.build_filenamev([localDir, localFilename]);
        let localFile = Gio.File.new_for_path(localPath);
        this.uriToLoad = localFile.get_uri();
    }

    createThumbnail(callback) {
        GdPrivate.queue_thumbnail_job_for_file_async(this._file, (object, res) => {
            let thumbnailed = false;

            try {
                thumbnailed = GdPrivate.queue_thumbnail_job_for_file_finish(res);
            } catch (e) {
                /* We don't care about reporting errors here, just fail the
                 * thumbnail.
                 */
            }

            callback(thumbnailed);
        });
    }

    updateTypeDescription() {
        let description = '';

        if (this.collection)
            description = _("Collection");
        else if (this.mimeType)
            description = Gio.content_type_get_description(this.mimeType);

        this.typeDescription = description;
    }

    downloadImpl(localFile, cancellable, callback) {
        let remoteFile = Gio.File.new_for_uri(this.uri);
        remoteFile.read_async(GLib.PRIORITY_DEFAULT, cancellable, (object, res) => {
            let inputStream;

            try {
                inputStream = object.read_finish(res);
            } catch (e) {
                callback(false, e);
                return;
            }

            Utils.replaceFile(localFile, inputStream, cancellable, (error) => {
                callback(false, error);
            });
        });
    }

    canEdit() {
        return false;
    }

    canShare() {
        return false;
    }

    canTrash() {
        return false;
    }

    getSourceLink() {
        let source = Application.sourceManager.getItemById(this.resourceUrn);
        let account = source.object.get_account();
        let presentationIdentity = account.presentation_identity;
        let uri ='https://' + presentationIdentity + '/';
        return [ uri, presentationIdentity ];
    }
}

const SKYDRIVE_PREFIX = 'windows-live:skydrive:';

const SkydriveDocument = class SkydriveDocument extends DocCommon {
    constructor(cursor) {
        super(cursor);

        this._failedThumbnailing = true;

        // overridden
        this.defaultAppName = _("OneDrive");
        this.sourceName = _("OneDrive");
    }

    populateFromCursor(cursor) {
        super.populateFromCursor(cursor);

        let localDir = GLib.build_filenamev([GLib.get_user_cache_dir(), "gnome-documents", "skydrive"]);

        let identifierHash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, this.identifier, -1);
        let filenameStripped = GdPrivate.filename_strip_extension(this.filename);
        let extension = this.filename.substring(filenameStripped.length);
        let localFilename = identifierHash + extension;

        let localPath = GLib.build_filenamev([localDir, localFilename]);
        let localFile = Gio.File.new_for_path(localPath);
        this.uriToLoad = localFile.get_uri();
    }

    _createZpjEntry(cancellable, callback) {
        let source = Application.sourceManager.getItemById(this.resourceUrn);

        let authorizer = new Zpj.GoaAuthorizer({ goa_object: source.object });
        let service = new Zpj.Skydrive({ authorizer: authorizer });
        let zpj_id = this.identifier.substring(SKYDRIVE_PREFIX.length);

        service.query_info_from_id_async
            (zpj_id, cancellable, (object, res) => {
                let entry = null;
                let exception = null;

                try {
                    entry = object.query_info_from_id_finish(res);
                } catch (e) {
                    exception = e;
                }

                callback(entry, service, exception);
            });
    }

    downloadImpl(localFile, cancellable, callback) {
        this._createZpjEntry(cancellable, (entry, service, error) => {
            if (error) {
                callback(false, error);
                return;
            }

            Utils.debug('Created ZpjEntry for ' + this.id);

            service.download_file_to_stream_async(entry, cancellable, (object, res) => {
                let inputStream;

                try {
                    inputStream = object.download_file_to_stream_finish(res);
                } catch (e) {
                    callback(false, e);
                    return;
                }

                Utils.replaceFile(localFile, inputStream, cancellable, (error) => {
                    callback(false, error);
                });
            });
        });
    }

    updateTypeDescription() {
        let description;

        if (this.collection)
            description = _("Collection");
        else if (this.rdfType.indexOf('nfo#Spreadsheet') != -1)
            description = _("Spreadsheet");
        else if (this.rdfType.indexOf('nfo#Presentation') != -1)
            description = _("Presentation");
        else
            description = _("Document");

        this.typeDescription = description;
    }

    canEdit() {
        return false;
    }

    canShare() {
        return false;
    }

    canTrash() {
        return false;
    }

    getSourceLink() {
        let uri = 'https://onedrive.live.com';
        return [ uri, this.sourceName ];
    }
}

var DocumentManager = class DocumentManager extends Manager.BaseManager {
    constructor() {
        super();

        this._loaderCancellable = null;

        this._activeCollection = null;
        this._collections = {};

        // a stack containing the collections which were used to
        // navigate to the active document or collection
        this._collectionPath = [];

        Application.changeMonitor.connect('changes-pending', this._onChangesPending.bind(this));
    }

    _onChangesPending(monitor, changes) {
        for (let idx in changes) {
            let changeEvent = changes[idx];

            if (changeEvent.type == ChangeMonitor.ChangeEventType.CHANGED) {
                let doc = this.getItemById(changeEvent.urn);

                if (doc)
                    doc.refresh();
            } else if (changeEvent.type == ChangeMonitor.ChangeEventType.CREATED) {
                this._onDocumentCreated(changeEvent.urn);
            } else if (changeEvent.type == ChangeMonitor.ChangeEventType.DELETED) {
                let doc = this.getItemById(changeEvent.urn);

                if (doc) {
                    doc.destroy();
                    this.removeItemById(changeEvent.urn);
                }
            }
        }
    }

    _onDocumentCreated(urn) {
        let job = new TrackerUtils.SingleItemJob(urn, Application.queryBuilder);
        job.run(Query.QueryFlags.NONE, (cursor) => {
            if (!cursor)
                return;

            this.addDocumentFromCursor(cursor);
        });
    }

    _identifierIsGoogle(identifier) {
        return (identifier &&
                (identifier.indexOf(GOOGLE_PREFIX) != -1));
    }

    _identifierIsOwncloud(identifier) {
        return (identifier &&
                (identifier.indexOf(OWNCLOUD_PREFIX) != -1));
    }

    _identifierIsSkydrive(identifier) {
        return (identifier &&
                (identifier.indexOf(SKYDRIVE_PREFIX) != -1));
    }

    createDocumentFromCursor(cursor) {
        let identifier = cursor.get_string(Query.QueryColumns.IDENTIFIER)[0];
        let doc;

        if (this._identifierIsGoogle(identifier))
            doc = new GoogleDocument(cursor);
        else if (this._identifierIsOwncloud(identifier))
            doc = new OwncloudDocument(cursor);
        else if (this._identifierIsSkydrive(identifier))
            doc = new SkydriveDocument(cursor);
        else
            doc = new LocalDocument(cursor);

        return doc;
    }

    addDocumentFromCursor(cursor) {
        let id = cursor.get_string(Query.QueryColumns.URN)[0];
        let doc = this.getItemById(id);

        if (doc) {
            this.emit('item-added', doc);
        } else {
            doc = this.createDocumentFromCursor(cursor);
            this.addItem(doc);
        }

        return doc;
    }

    addItem(doc) {
        if (doc.collection) {
            let oldCollection = this._collections[doc.id];
            if (oldCollection)
                this.removeItem(oldCollection);

            this._collections[doc.id] = doc;
        }

        super.addItem(doc);
    }

    clear() {
        this._collections = {};
        this._activeCollection = null;

        let items = this.getItems();
        for (let idx in items) {
            items[idx].destroy();
        };

        super.clear();
    }

    clearRowRefs() {
        let items = this.getItems();
        for (let idx in items) {
            items[idx].rowRefs = {};
        }
    }

    getActiveCollection() {
        return this._activeCollection;
    }

    getCollections() {
        return this._collections;
    }

    getWhere() {
        let retval = '';

        if (this._activeCollection)
            retval = this._activeCollection.getWhere();

        return retval;
    }

    _humanizeError(error) {
        let message = error.message;
        if (error.domain == GData.ServiceError) {
            switch (error.code) {
            case GData.ServiceError.NETWORK_ERROR:
                message = _("Please check the network connection.");
                break;
            case GData.ServiceError.PROXY_ERROR:
                message = _("Please check the network proxy settings.");
                break;
            case GData.ServiceError.AUTHENTICATION_REQUIRED:
                message = _("Unable to sign in to the document service.");
                break;
            case GData.ServiceError.NOT_FOUND:
                message = _("Unable to locate this document.");
                break;
            default:
                message = _("Hmm, something is fishy (%d).").format(error.code);
                break;
            }
        } else if (error.domain == Gio.IOErrorEnum) {
            switch (error.code) {
            case Gio.IOErrorEnum.NOT_SUPPORTED:
                message = _("LibreOffice support is not available. Please contact your system administrator.");
                break;
            default:
                break;
            }
        }

        let exception = new GLib.Error(error.domain, error.code, message);
        return exception;
    }

    _onDocumentLoadError(doc, error) {
        if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;

        if (error.matches(EvDocument.DocumentError, EvDocument.DocumentError.ENCRYPTED)) {
            this.emit('password-needed', doc);
            return;
        }

        logError(error, 'Unable to load document');

        // Translators: %s is the title of a document
        let message = _("Oops! Unable to load “%s”").format(doc.name);
        let exception = this._humanizeError(error);
        this.emit('load-error', doc, message, exception);
    }

    _onDocumentLoaded(doc, docModel, error) {
        this._loaderCancellable = null;

        if (error) {
            this._onDocumentLoadError(doc, error);
            return;
        }

        this.emit('load-finished', doc, docModel);
    }

    _requestPreview(doc) {
        let windowMode;
        if (LOKView.isOpenDocumentFormat(doc.mimeType)) {
            windowMode = WindowMode.WindowMode.PREVIEW_LOK;
        } else {
            windowMode = WindowMode.WindowMode.PREVIEW_EV;
        }

        Application.modeController.setWindowMode(windowMode);
    }

    _loadActiveItem(passwd) {
        let doc = this.getActiveItem();

        this._loaderCancellable = new Gio.Cancellable();
        this._requestPreview(doc);
        this.emit('load-started', doc);
        doc.load(passwd, this._loaderCancellable, this._onDocumentLoaded.bind(this));
    }

    reloadActiveItem(passwd) {
        let doc = this.getActiveItem();

        if (!doc)
            return;

        if (doc.collection)
            return;

        // cleanup any state we have for previously loaded model
        this._clearActiveDocModel();

        this._loadActiveItem(passwd);
    }

    removeItemById(id) {
        if (this._collections[id]) {
            delete this._collections[id];
        }

        super.removeItemById(id);
    }

    setActiveItem(doc) {
        let activeCollectionChanged = false;
        let activeDoc = this.getActiveItem();
        let retval = false;
        let startLoading = false;

        // Passing null is a way to go back to the current collection or
        // overview from the preview. However, you can't do that when you
        // are looking at a collection. Use activatePreviousCollection for
        // unwinding the collection stack.
        if (!doc) {
            if (activeDoc != this._activeCollection)
                doc = this._activeCollection;
            else
                return false;
        }

        // cleanup any state we have for previously loaded model
        this._clearActiveDocModel();

        // If doc is null then we are going back to the overview from
        // the preview.
        if (doc) {
            if (doc.collection) {
                // If doc is the active collection then we are going back to the
                // collection from the preview.
                if (doc != this._activeCollection) {
                    this._collectionPath.push(this._activeCollection);
                    this._activeCollection = doc;
                    activeCollectionChanged = true;
                }
            } else {
                startLoading = true;
            }
        }

        retval = super.setActiveItem(doc);

        if (retval && activeCollectionChanged)
            this.emit('active-collection-changed', this._activeCollection);

        if (retval && startLoading) {
            let recentManager = Gtk.RecentManager.get_default();
            recentManager.add_item(doc.uri);

            this._loadActiveItem(null);
        }

        return retval;
    }

    activatePreviousCollection() {
        this._clearActiveDocModel();

        let collection = this._collectionPath.pop();
        this._activeCollection = collection;
        Manager.BaseManager.prototype.setActiveItem.call(this, collection);
        this.emit('active-collection-changed', this._activeCollection);
    }

    _clearActiveDocModel() {
        // cancel any pending load operation
        if (this._loaderCancellable) {
            this._loaderCancellable.cancel();
            this._loaderCancellable = null;
        }
    }
}
