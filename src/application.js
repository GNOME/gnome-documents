/*
 * Copyright (c) 2011, 2012, 2014, 2015 Red Hat, Inc.
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
const Mainloop = imports.mainloop;
const _ = imports.gettext.gettext;

const EvDoc = imports.gi.EvinceDocument;
const Gdk = imports.gi.Gdk;
const Gio = imports.gi.Gio;
const Goa = imports.gi.Goa;
const Gtk = imports.gi.Gtk;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Tracker = imports.gi.Tracker;
const TrackerControl = imports.gi.TrackerControl;

const ChangeMonitor = imports.changeMonitor;
const Format = imports.format;
const MainWindow = imports.mainWindow;
const Miners = imports.miners;
const Notifications = imports.notifications;
const Properties = imports.properties;
const Query = imports.query;
const Search = imports.search;
const Selections = imports.selections;
const ShellSearchProvider = imports.shellSearchProvider;
const TrackerController = imports.trackerController;
const TrackerUtils = imports.trackerUtils;
const Utils = imports.utils;
const WindowMode = imports.windowMode;

// used globally
var application = null;
var connection = null;
var connectionQueue = null;
var goaClient = null;
var settings = null;

// used by the application, but not by the search provider
var changeMonitor = null;
let cssProvider = null;
var documentManager = null;
var modeController = null;
var notificationManager = null;
var offsetCollectionsController = null;
var offsetDocumentsController = null;
var offsetSearchController = null;
var queryBuilder = null;
var searchController = null;
var searchMatchManager = null;
var searchTypeManager = null;
var selectionController = null;
var sourceManager = null;
var trackerCollectionsController = null;
var trackerDocumentsController = null;
var trackerSearchController = null;

const TrackerExtractPriorityIface = '<node> \
<interface name="org.freedesktop.Tracker1.Extract.Priority"> \
    <method name="ClearRdfTypes" /> \
    <method name="SetRdfTypes"> \
        <arg name="rdf_types" type="as" /> \
    </method> \
</interface> \
</node>';

var TrackerExtractPriorityProxy = Gio.DBusProxy.makeProxyWrapper(TrackerExtractPriorityIface);
function TrackerExtractPriority() {
    return new TrackerExtractPriorityProxy(Gio.DBus.session,
                                           'org.freedesktop.Tracker1.Miner.Extract',
                                           '/org/freedesktop/Tracker1/Extract/Priority');
}

const MINER_REFRESH_TIMEOUT = 60; /* seconds */

var Application = GObject.registerClass({
    Signals: {
        'miners-changed': {}
    }
}, class Application extends Gtk.Application {

    _init() {
        this.minersRunning = [];
        this._activationTimestamp = Gdk.CURRENT_TIME;
        this._extractPriority = null;
        this._searchProvider = null;

        let appid;
        GLib.set_application_name(_("Documents"));
        appid = 'org.gnome.Documents';

        // needed by data/ui/view-menu.ui
        GObject.type_ensure(Gio.ThemedIcon);

        super._init({ application_id: appid,
                      inactivity_timeout: 12000 });

        this.add_main_option('version', 'v'.charCodeAt(0), GLib.OptionFlags.NONE, GLib.OptionArg.NONE,
                             _("Show the version of the program"), null);
    }

    _initGettingStarted() {
        let manager = TrackerControl.MinerManager.new_full(false);

        let languages = GLib.get_language_names();
        let files = languages.map(
            function(language) {
                return Gio.File.new_for_path(pkg.pkgdatadir + '/getting-started/' + language +
                    '/gnome-documents-getting-started.pdf');
            });

        this.gettingStartedLocation = null;

        for (let i in files) {
            try {
                let info = files[i].query_info(Gio.FILE_ATTRIBUTE_STANDARD_TYPE,
                                               Gio.FileQueryInfoFlags.NONE,
                                               null);
            } catch (e) {
                continue;
            }

            this.gettingStartedLocation = files[i].get_parent();

            try {
                manager.index_file(files[i], null);
            } catch (e) {
                logError(e, 'Error indexing the getting started PDF');
            }

            break;
        }

        if (!this.gettingStartedLocation)
            log('Can\'t find a valid getting started PDF document');
    }

    _nightModeCreateHook(action) {
        settings.connect('changed::night-mode', Lang.bind(this,
            function() {
                let state = settings.get_value('night-mode');
                if (state.get_boolean() != action.state.get_boolean())
                    action.change_state(state);

                let gtkSettings = Gtk.Settings.get_default();
                gtkSettings.gtk_application_prefer_dark_theme = state.get_boolean();
            }));

        let state = settings.get_value('night-mode');
        let gtkSettings = Gtk.Settings.get_default();
        gtkSettings.gtk_application_prefer_dark_theme = state.get_boolean();
    }

    _onActionQuit() {
        this._mainWindow.destroy();
    }

    _onActionAbout() {
        this._mainWindow.showAbout();
    }

    _onActionHelp() {
        try {
            Gtk.show_uri_on_window(this._mainWindow,
                                   'help:gnome-documents',
                                   Gtk.get_current_event_time());
        } catch (e) {
            logError(e, 'Unable to display help');
        }
    }

    _onActionNightMode(action) {
        let state = action.get_state();
        settings.set_value('night-mode', GLib.Variant.new('b', !state.get_boolean()));
    }

    _createMiners(callback) {
        let count = 3;

        this.gdataMiner = new Miners.GDataMiner(Lang.bind(this,
            function() {
                count--;
                if (count == 0)
                    callback();
            }));

        this.owncloudMiner = new Miners.OwncloudMiner(Lang.bind(this,
            function() {
                count--;
                if (count == 0)
                    callback();
            }));

        this.zpjMiner = new Miners.ZpjMiner(Lang.bind(this,
            function() {
                count--;
                if (count == 0)
                    callback();
            }));
    }

    _refreshMinerNow(miner) {
        let env = GLib.getenv('DOCUMENTS_DISABLE_MINERS');
        if (env)
            return false;

        if (!miner)
            return false;

        this.minersRunning.push(miner);
        this.emit('miners-changed');

        miner._cancellable = new Gio.Cancellable();
        miner.RefreshDBRemote(['documents'], miner._cancellable, Lang.bind(this,
            function(res, error) {
                this.minersRunning = this.minersRunning.filter(
                    function(element) {
                        return element != miner;
                    });
                this.emit('miners-changed');

                if (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(error, 'Error updating the cache');

                    return;
                }

                Mainloop.timeout_add_seconds(MINER_REFRESH_TIMEOUT,
                                             Lang.bind(this, function() {
                                                 this._refreshMinerNow(miner);
                                             }));
            }));

        return false;
    }

    _refreshMiners() {
        if (sourceManager.hasProviderType('google')) {
            try {
                // startup a refresh of the gdocs cache
                this._refreshMinerNow(this.gdataMiner);
            } catch (e) {
                logError(e, 'Unable to start GData miner');
            }
        }

        if (sourceManager.hasProviderType('owncloud')) {
            try {
                // startup a refresh of the owncloud cache
                this._refreshMinerNow(this.owncloudMiner);
            } catch (e) {
                logError(e, 'Unable to start Owncloud miner');
            }
        }

        if (sourceManager.hasProviderType('windows_live')) {
            try {
                // startup a refresh of the skydrive cache
                this._refreshMinerNow(this.zpjMiner);
            } catch (e) {
                logError(e, 'Unable to start Zpj miner');
            }
        }
    }

    _startMiners() {
        this._createMiners(Lang.bind(this,
            function() {
                this._refreshMiners();

                this._sourceAddedId = sourceManager.connect('item-added',
                                                            Lang.bind(this, this._refreshMiners));
                this._sourceRemovedId = sourceManager.connect('item-removed',
                                                              Lang.bind(this, this._refreshMiners));
            }));
    }

    _stopMiners() {
        if (this._sourceAddedId != 0) {
            sourceManager.disconnect(this._sourceAddedId);
            this._sourceAddedId = 0;
        }

        if (this._sourceRemovedId != 0) {
            sourceManager.disconnect(this._sourceRemovedId);
            this._sourceRemovedId = 0;
        }

        this.minersRunning.forEach(Lang.bind(this,
            function(miner) {
                miner._cancellable.cancel();
            }));
        this.minersRunning = [];

        this.gdataMiner = null;
        this.owncloudMiner = null;
        this.zpjMiner = null;
    }

    _themeChanged(gtkSettings) {
        let screen = Gdk.Screen.get_default();

        if (gtkSettings.gtk_theme_name == 'Adwaita') {
            if (cssProvider == null) {
                cssProvider = new Gtk.CssProvider();
                let file = Gio.File.new_for_uri("resource:///org/gnome/Documents/application.css");
                cssProvider.load_from_file(file);
            }

            Gtk.StyleContext.add_provider_for_screen(screen,
                                                     cssProvider,
                                                     Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        } else if (cssProvider != null) {
            Gtk.StyleContext.remove_provider_for_screen(screen, cssProvider);
        }
    }

    vfunc_startup() {
        application = this;
        super.vfunc_startup();
        String.prototype.format = Format.format;

        EvDoc.init();

        settings = new Gio.Settings({ schema_id: 'org.gnome.documents' });

        let gtkSettings = Gtk.Settings.get_default();
        gtkSettings.connect('notify::gtk-theme-name', Lang.bind(this, this._themeChanged));
        this._themeChanged(gtkSettings);

        // connect to tracker
        try {
            connection = Tracker.SparqlConnection.get(null);
        } catch (e) {
            logError(e, 'Unable to connect to the tracker database');
            return;
        }

        try {
            goaClient = Goa.Client.new_sync(null);
        } catch (e) {
            logError(e, 'Unable to create the GOA client');
            return;
        }

        connectionQueue = new TrackerController.TrackerConnectionQueue();
        changeMonitor = new ChangeMonitor.TrackerChangeMonitor();

        // now init application components
        Search.initSearch(imports.application);
        Search.initSearch(imports.shellSearchProvider);

        modeController = new WindowMode.ModeController();
        offsetCollectionsController = new Search.OffsetCollectionsController();
        offsetDocumentsController = new Search.OffsetDocumentsController();
        offsetSearchController = new Search.OffsetSearchController();
        trackerCollectionsController = new TrackerController.TrackerCollectionsController();
        trackerDocumentsController = new TrackerController.TrackerDocumentsController();
        trackerSearchController = new TrackerController.TrackerSearchController();
        selectionController = new Selections.SelectionController();

        let actionEntries = [
            { name: 'quit',
              callback: Lang.bind(this, this._onActionQuit),
              accels: ['<Primary>q'] },
            { name: 'about',
              callback: Lang.bind(this, this._onActionAbout) },
            { name: 'help',
              callback: Lang.bind(this, this._onActionHelp),
              accels: ['F1'] },
            { name: 'night-mode',
              callback: Lang.bind(this, this._onActionNightMode),
              create_hook: Lang.bind(this, this._nightModeCreateHook),
              state: settings.get_value('night-mode') },
        ];

        Utils.populateActionGroup(this, actionEntries, 'app');
    }

    _createWindow() {
        if (this._mainWindow)
            return;

        this._initGettingStarted();

        notificationManager = new Notifications.NotificationManager();
        this._mainWindow = new MainWindow.MainWindow(this);
        this._mainWindow.connect('destroy', Lang.bind(this, this._onWindowDestroy));

        try {
            this._extractPriority = TrackerExtractPriority();
            this._extractPriority.SetRdfTypesRemote(['nfo:Document']);
        } catch (e) {
            logError(e, 'Unable to connect to the tracker extractor');
        }

        // start miners
        this._startMiners();
    }

    vfunc_dbus_register(connection, path) {
        super.vfunc_dbus_register(connection, path);

        if (this._searchProvider != null)
            throw(new Error('ShellSearchProvider already instantiated - dbus_register called twice?'));

        this._searchProvider = new ShellSearchProvider.ShellSearchProvider();
        this._searchProvider.connect('activate-result', Lang.bind(this, this._onActivateResult));
        this._searchProvider.connect('launch-search', Lang.bind(this, this._onLaunchSearch));

        try {
            this._searchProvider.export(connection);
        } catch(e) {
            this._searchProvider = null;
            throw(e);
        }

        return true;
    }

    vfunc_dbus_unregister(connection, path) {
        if (this._searchProvider != null) {
            this._searchProvider.unexport(connection);
            this._searchProvider = null;
        }

        super.vfunc_dbus_unregister(connection, path);
    }

    vfunc_handle_local_options(options) {
        if (options.contains('version')) {
            print(pkg.version);
            return 0;
        }

        return -1;
    }

    vfunc_activate() {
        if (!this._mainWindow) {
            this._createWindow();
            modeController.setWindowMode(WindowMode.WindowMode.DOCUMENTS);
        }

        this._mainWindow.present_with_time(this._activationTimestamp);
        this._activationTimestamp = Gdk.CURRENT_TIME;
    }

    _clearState() {
        // clean up signals
        changeMonitor.disconnectAll();
        documentManager.disconnectAll();
        offsetCollectionsController.disconnectAll();
        offsetDocumentsController.disconnectAll();
        offsetSearchController.disconnectAll();
        trackerCollectionsController.disconnectAll();
        trackerDocumentsController.disconnectAll();
        trackerSearchController.disconnectAll();
        selectionController.disconnectAll();
        modeController.disconnectAll();

        // reset state
        documentManager.clearRowRefs();
        documentManager.setActiveItem(null);
        modeController.setWindowMode(WindowMode.WindowMode.NONE);
        selectionController.setSelection(null);
        notificationManager = null;

        // stop miners
        this._stopMiners();

        if (this._extractPriority)
            this._extractPriority.ClearRdfTypesRemote();
    }

    _onWindowDestroy(window) {
        this._mainWindow = null;

        // clear our state in an idle, so other handlers connected
        // to 'destroy' have the chance to perform their cleanups first
        Mainloop.idle_add(Lang.bind(this, this._clearState));
    }

    _onActivateResult(provider, urn, terms, timestamp) {
        this._createWindow();

        let doc = documentManager.getItemById(urn);
        if (doc) {
            doActivate.apply(this, [doc]);
        } else {
            let job = new TrackerUtils.SingleItemJob(urn, queryBuilder);
            job.run(Query.QueryFlags.UNFILTERED, Lang.bind(this,
                function(cursor) {
                    if (cursor)
                        doc = documentManager.addDocumentFromCursor(cursor);

                    doActivate.apply(this, [doc]);
                }));
        }

        function doActivate(doc) {
            documentManager.setActiveItem(doc);

            this._activationTimestamp = timestamp;
            this.activate();

            // forward the search terms next time we enter the overview
            let modeChangeId = modeController.connect('window-mode-changed', Lang.bind(this,
                function(object, newMode) {
                    if (newMode == WindowMode.WindowMode.DOCUMENTS) {
                        modeController.disconnect(modeChangeId);
                        searchController.setString(terms.join(' '));
                    }
                }));
        }
    }

    _onLaunchSearch(provider, terms, timestamp) {
        this._createWindow();
        modeController.setWindowMode(WindowMode.WindowMode.DOCUMENTS);
        searchController.setString(terms.join(' '));

        this._activationTimestamp = timestamp;
        this.activate();
    }

    getScaleFactor() {
        let scaleFactor = 1;
        if (this._mainWindow)
            scaleFactor = this._mainWindow.get_scale_factor();

        return scaleFactor;
    }

    getGdkWindow() {
        let window = null;
        if (this._mainWindow)
            window = this._mainWindow.get_window();

        return window;
    }
});
