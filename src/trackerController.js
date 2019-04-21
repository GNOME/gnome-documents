/*
 * Copyright (c) 2011, 2013, 2014 Red Hat, Inc.
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

const Lang = imports.lang;
const Signals = imports.signals;

const Application = imports.application;
const Query = imports.query;
const Utils = imports.utils;
const WindowMode = imports.windowMode;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const _ = imports.gettext.gettext;

const QueryType = {
    SELECT: 0,
    UPDATE: 1,
    UPDATE_BLANK: 2
};

var TrackerConnectionQueue = GObject.registerClass(
    class TrackerConnectionQueue extends GObject.Object {

    _init() {
        this._queue = [];
        this._running = false;
    }

    add(query, cancellable, callback) {
        let params = { query: query,
                       cancellable: cancellable,
                       callback: callback,
                       queryType: QueryType.SELECT };
        this._queue.push(params);

        this._checkQueue();
    }

    update(query, cancellable, callback) {
        let params = { query: query,
                       cancellable: cancellable,
                       callback: callback,
                       queryType: QueryType.UPDATE };
        this._queue.push(params);

        this._checkQueue();
    }

    updateBlank(query, cancellable, callback) {
        let params = { query: query,
                       cancellable: cancellable,
                       callback: callback,
                       queryType: QueryType.UPDATE_BLANK };
        this._queue.push(params);

        this._checkQueue();
    }

    _checkQueue() {
        if (this._running)
            return;

        if (!this._queue.length)
            return;

        let params = this._queue.shift();
        this._running = true;

        if (params.queryType == QueryType.SELECT)
            Application.connection.query_async(params.query, params.cancellable,
                                          Lang.bind(this, this._queueCollector, params));
        else if (params.queryType == QueryType.UPDATE)
            Application.connection.update_async(params.query, GLib.PRIORITY_DEFAULT, params.cancellable,
                                           Lang.bind(this, this._queueCollector, params));
        else if (params.queryType == QueryType.UPDATE_BLANK)
            Application.connection.update_blank_async(params.query, GLib.PRIORITY_DEFAULT, params.cancellable,
                                                 Lang.bind(this, this._queueCollector, params));
    }

    _queueCollector(connection, res, params) {
        params.callback(connection, res);
        this._running = false;
        this._checkQueue();
    }
});

const RefreshFlags = {
    NONE: 0,
    RESET_OFFSET: 1 << 0
};

const TrackerController = GObject.registerClass(
    class TrackerController extends GObject.Object {

    _init(windowMode) {
        this._currentQuery = null;
        this._cancellable = new Gio.Cancellable();
        this._mode = windowMode;
        this._queryQueued = false;
        this._queryQueuedFlags = RefreshFlags.NONE;
        this._querying = false;
        this._isStarted = false;
        this._refreshPending = false;
        this.sortBy = null;

        // useful for debugging
        this._lastQueryTime = 0;

        Application.sourceManager.connect('item-added', Lang.bind(this, this._onSourceAddedRemoved));
        Application.sourceManager.connect('item-removed', Lang.bind(this, this._onSourceAddedRemoved));

        Application.modeController.connect('window-mode-changed', Lang.bind(this,
            function(object, newMode) {
                if (this._refreshPending && newMode == this._mode)
                    this._refreshForSource();
            }));

        this._offsetController = this.getOffsetController();
        this._offsetController.connect('offset-changed', Lang.bind(this, this._performCurrentQuery));

        Application.settings.connect('changed::sort-by', Lang.bind(this, this._updateSortForSettings));
        this._updateSortForSettings();
    }

    getOffsetController() {
        log('Error: TrackerController implementations must override getOffsetController');
    }

    _setQueryStatus(status) {
        if (this._querying == status)
            return;

        if (status) {
            this._lastQueryTime = GLib.get_monotonic_time();
        } else {
            Utils.debug('Query Elapsed: '
                        + (GLib.get_monotonic_time() - this._lastQueryTime) / 1000000);
            this._lastQueryTime = 0;
        }

        this._querying = status;
        this.emit('query-status-changed', this._querying);
    }

    getQuery() {
        log('Error: TrackerController implementations must override getQuery');
    }

    getQueryStatus() {
        return this._querying;
    }

    _onQueryError(exception) {
        if (exception.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            return;

        let message = _("Unable to fetch the list of documents");
        this.emit('query-error', message, exception);
    }

    _onQueryFinished(exception) {
        this._setQueryStatus(false);

        if (exception)
            this._onQueryError(exception);
        else
            this._offsetController.resetItemCount();

        if (this._queryQueued) {
            this._queryQueued = false;
            this._refreshInternal(this._queryQueuedFlags);
        }
    }

    _onCursorNext(cursor, res) {
        try {
            let valid = cursor.next_finish(res);

            if (!valid) {
                // signal the total count update and return
                cursor.close();
                this._onQueryFinished(null);
                return;
            }
        } catch (e) {
            cursor.close();
            this._onQueryFinished(e);
            return;
        }

        Utils.debug('Query Cursor: '
                    + (GLib.get_monotonic_time() - this._lastQueryTime) / 1000000);
        Application.documentManager.addDocumentFromCursor(cursor);
        cursor.next_async(this._cancellable, Lang.bind(this, this._onCursorNext));
    }

    _onQueryExecuted(object, res) {
        try {
            Utils.debug('Query Executed: '
                        + (GLib.get_monotonic_time() - this._lastQueryTime) / 1000000);

            let cursor = object.query_finish(res);
            cursor.next_async(this._cancellable, Lang.bind(this, this._onCursorNext));
        } catch (e) {
            this._onQueryFinished(e);
        }
    }

    _performCurrentQuery() {
        this._currentQuery = this.getQuery();
        this._cancellable.reset();

        Application.connectionQueue.add(this._currentQuery.sparql,
                                        this._cancellable, Lang.bind(this, this._onQueryExecuted));
    }

    _refreshInternal(flags) {
        if (!this._isStarted)
            throw(new Error('!this._isStarted'));

        if (flags & RefreshFlags.RESET_OFFSET)
            this._offsetController.resetOffset();

        if (this.getQueryStatus()) {
            this._cancellable.cancel();
            this._queryQueued = true;
            this._queryQueuedFlags = flags;

            return;
        }

        this._setQueryStatus(true);
        this._performCurrentQuery();
    }

    refreshForObject(_object, _item) {
        this._refreshInternal(RefreshFlags.RESET_OFFSET);
    }

    _refreshForSource() {
        // When a source is added or removed, refresh the model only if
        // the current source is All.
        // If it was the current source to be removed, we will get an
        // 'active-changed' signal, so avoid refreshing twice
        if (this._currentQuery.activeSource &&
            this._currentQuery.activeSource.id == 'all')
            this._refreshInternal(RefreshFlags.NONE);

        this._refreshPending = false;
    }

    _onSourceAddedRemoved(manager, item) {
        let mode = Application.modeController.getWindowMode();

        if (mode == this._mode)
            this._refreshForSource();
        else
            this._refreshPending = true;
    }

    _updateSortForSettings() {
        let sortBy = Application.settings.get_enum('sort-by');

        if(this.sortBy == sortBy)
            return;

        this.sortBy = sortBy;

        if (!this._isStarted)
            return;

        this._refreshInternal(RefreshFlags.RESET_OFFSET);
    }

    start() {
        if (this._isStarted)
            return;

        this._isStarted = true;
        this._refreshInternal(RefreshFlags.NONE);
    }
});
Signals.addSignalMethods(TrackerController.prototype);

var TrackerCollectionsController = GObject.registerClass(
    class TrackerCollectionsController extends TrackerController {

    _init() {
        super._init(WindowMode.WindowMode.COLLECTIONS);

        Application.documentManager.connect('active-collection-changed', Lang.bind(this,
            function() {
                let windowMode = Application.modeController.getWindowMode();
                if (windowMode == WindowMode.WindowMode.COLLECTIONS)
                    this.refreshForObject();
            }));
    }

    getOffsetController() {
        return Application.offsetCollectionsController;
    }

    getQuery() {
        let flags;
        let activeCollection = Application.documentManager.getActiveCollection();

        if (activeCollection)
            flags = Query.QueryFlags.NONE;
        else
            flags = Query.QueryFlags.COLLECTIONS;

        return Application.queryBuilder.buildGlobalQuery(flags,
                                                         Application.offsetCollectionsController,
                                                         this.sortBy);
    }
});

var TrackerDocumentsController = GObject.registerClass(
    class TrackerDocumentsController extends TrackerController {

    _init() {
        super._init(WindowMode.WindowMode.DOCUMENTS);
    }

    getOffsetController() {
        return Application.offsetDocumentsController;
    }

    getQuery() {
        return Application.queryBuilder.buildGlobalQuery(Query.QueryFlags.DOCUMENTS,
                                                         Application.offsetDocumentsController,
                                                         this.sortBy);
    }
});

var TrackerSearchController = GObject.registerClass(
    class TrackerSearchController extends TrackerController {

    _init() {
        super._init(WindowMode.WindowMode.SEARCH);

        Application.documentManager.connect('active-collection-changed', Lang.bind(this,
            function() {
                let windowMode = Application.modeController.getWindowMode();
                if (windowMode == WindowMode.WindowMode.SEARCH)
                    this.refreshForObject();
            }));

        Application.sourceManager.connect('active-changed', Lang.bind(this, this.refreshForObject));
        Application.searchController.connect('search-string-changed', Lang.bind(this, this.refreshForObject));
        Application.searchTypeManager.connect('active-changed', Lang.bind(this, this.refreshForObject));

        Application.searchMatchManager.connect('active-changed', Lang.bind(this, this._onSearchMatchChanged));
    }

    _onSearchMatchChanged() {
        // when the "match" search setting changes, refresh only if
        // the search string is not empty
        if (Application.searchController.getString() != '')
            this.refreshForObject();
    }

    getOffsetController() {
        return Application.offsetSearchController;
    }

    getQuery() {
        return Application.queryBuilder.buildGlobalQuery(Query.QueryFlags.SEARCH,
                                                         Application.offsetSearchController,
                                                         this.sortBy);
    }
});
