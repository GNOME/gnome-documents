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

const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Signals = imports.signals;

const Application = imports.application;

const TrackerResourcesServiceIface = '<node> \
<interface name="org.freedesktop.Tracker1.Resources"> \
    <signal name="GraphUpdated"> \
        <arg name="className" type="s" /> \
        <arg name="deleteEvents" type="a(iiii)" /> \
        <arg name="insertEvents" type="a(iiii)" /> \
    </signal> \
</interface> \
</node>';

var TrackerResourcesServiceProxy = Gio.DBusProxy.makeProxyWrapper(TrackerResourcesServiceIface);
function TrackerResourcesService() {
    return new TrackerResourcesServiceProxy(Gio.DBus.session,
                                            'org.freedesktop.Tracker1',
                                            '/org/freedesktop/Tracker1/Resources');
}

var ChangeEventType = {
    CHANGED: 0,
    CREATED: 1,
    DELETED: 2
};

const _RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const ChangeEvent = GObject.registerClass(
    class ChangeEvent extends GObject.Object {

    _init(urnId, predicateId, isDelete) {
        this.urnId = urnId;
        this.predicateId = predicateId;

        if (isDelete)
            this.type = ChangeEventType.DELETED;
        else
            this.type = ChangeEventType.CREATED;
    }

    setResolvedValues(urn, predicate) {
        this.urn = urn;
        this.predicate = predicate;

        if (predicate != _RDF_TYPE)
            this.type = ChangeEventType.CHANGED;
    }

    merge(event) {
        // deletions or creations override the current type
        if (event.type == ChangeEventType.DELETED ||
            event.type == ChangeEventType.CREATED) {
            this.type = event.type;
        }
    }
});

const CHANGE_MONITOR_TIMEOUT = 500; // msecs
const CHANGE_MONITOR_MAX_ITEMS = 500; // items

var TrackerChangeMonitor = GObject.registerClass(
    class TrackerChangeMonitor extends GObject.Object {

    _init() {
        this._pendingChanges = {};
        this._unresolvedIds = {};

        this._pendingEvents = [];
        this._pendingEventsId = 0;

        this._resourceService = new TrackerResourcesService();
        this._resourceService.connectSignal('GraphUpdated', Lang.bind(this, this._onGraphUpdated));
    }

    _onGraphUpdated(proxy, senderName, [className, deleteEvents, insertEvents]) {
        deleteEvents.forEach(Lang.bind(this,
            function(event) {
                this._addPendingEvent(event, true);
            }));

        insertEvents.forEach(Lang.bind(this,
            function(event) {
                this._addPendingEvent(event, false);
            }));
    }

    _addPendingEvent(event, isDelete) {
        if (this._pendingEventsId != 0)
            Mainloop.source_remove(this._pendingEventsId);

        this._unresolvedIds[event[1]] = event[1];
        this._unresolvedIds[event[2]] = event[2];
        this._pendingEvents.push(new ChangeEvent(event[1], event[2], isDelete));

        if (this._pendingEvents.length >= CHANGE_MONITOR_MAX_ITEMS)
            this._processEvents();
        else
            this._pendingEventsId =
                Mainloop.timeout_add(CHANGE_MONITOR_TIMEOUT, Lang.bind(this, this._processEvents));
    }

    _processEvents() {
        let events = this._pendingEvents;
        let idTable = this._unresolvedIds;

        this._pendingEventsId = 0;
        this._pendingEvents = [];
        this._unresolvedIds = {};

        let sparql = 'SELECT';
        Object.keys(idTable).forEach(Lang.bind(this,
            function(unresolvedId) {
                sparql += (' tracker:uri(%d)').format(unresolvedId);
            }));
        sparql += ' {}';

        // resolve all the unresolved IDs we got so far
        Application.connectionQueue.add(sparql, null, Lang.bind(this,
            function(object, res) {
                let cursor = object.query_finish(res);

                cursor.next_async(null, Lang.bind(this,
                    function(object, res) {
                        let valid = false;
                        try {
                            valid = cursor.next_finish(res);
                        } catch(e) {
                            logError(e, 'Unable to resolve item URNs for graph changes');
                        }

                        if (valid) {
                            let idx = 0;
                            Object.keys(idTable).forEach(Lang.bind(this,
                                function(unresolvedId) {
                                    idTable[unresolvedId] = cursor.get_string(idx)[0];
                                    idx++;
                                }));

                            this._sendEvents(events, idTable);
                        }

                        cursor.close();
                    }));
            }));

        return false;
    }

    _addEvent(event) {
        let urn = event.urn;
        let oldEvent = this._pendingChanges[urn];

        if (oldEvent != null) {
            oldEvent.merge(event);
            this._pendingChanges[urn] = oldEvent;
        } else {
            this._pendingChanges[urn] = event;
        }
    }

    _sendEvents(events, idTable) {
        events.forEach(Lang.bind(this,
            function(event) {
                event.setResolvedValues(idTable[event.urnId], idTable[event.predicateId]);
                this._addEvent(event);
            }));

        this.emit('changes-pending', this._pendingChanges);
        this._pendingChanges = {};
    }
});
Signals.addSignalMethods(TrackerChangeMonitor.prototype);
