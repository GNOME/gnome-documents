/*
 * Copyright (c) 2012 Red Hat, Inc.
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
const Gettext = imports.gettext;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const TrackerControl = imports.gi.TrackerControl;
const _ = imports.gettext.gettext;

const Application = imports.application;
const WindowMode = imports.windowMode;

const Lang = imports.lang;
const Mainloop = imports.mainloop;

var DELETE_TIMEOUT = 10; // seconds

var DeleteNotification = GObject.registerClass(
    class DeleteNotification extends GObject.Object {

    _init(docs) {
        this._docs = docs;
        this.widget = new Gtk.Grid({ orientation: Gtk.Orientation.HORIZONTAL,
                                     column_spacing: 12 });

        let msg;

        if (this._docs.length == 1 && this._docs[0].name) {
            // Translators: only one item has been deleted and %s is its name
            msg = (_("“%s” deleted")).format(this._docs[0].name);
        } else {
            // Translators: one or more items might have been deleted, and %d
            // is the count
            msg = Gettext.ngettext("%d item deleted",
                                   "%d items deleted",
                                   this._docs.length).format(this._docs.length);
        }

        let label = new Gtk.Label({ label: msg,
                                    halign: Gtk.Align.START });
        this.widget.add(label);

        let undo = new Gtk.Button({ label: _("Undo"),
                                    valign: Gtk.Align.CENTER });
        this.widget.add(undo);
        undo.connect('clicked', Lang.bind(this,
            function() {
                this._docs.forEach(Lang.bind(this,
                    function(doc) {
                        Application.documentManager.addItem(doc);
                    }));

                this._removeTimeout();
                this.widget.destroy();
            }));

        let close = new Gtk.Button({ image: new Gtk.Image({ icon_name: 'window-close-symbolic',
                                                            pixel_size: 16,
                                                            margin_top: 2,
                                                            margin_bottom: 2 }),
                                     valign: Gtk.Align.CENTER,
                                     focus_on_click: false,
                                     relief: Gtk.ReliefStyle.NONE });
        this.widget.add(close);
        close.connect('clicked', Lang.bind(this, this._deleteItems));

        Application.notificationManager.addNotification(this);
        this._timeoutId = Mainloop.timeout_add_seconds(DELETE_TIMEOUT, Lang.bind(this,
            function() {
                this._timeoutId = 0;
                this._deleteItems();
                return false;
            }));
    }

    _deleteItems() {
        this._docs.forEach(Lang.bind(this,
            function(doc) {
                doc.trash();
            }))

        this._removeTimeout();
        this.widget.destroy();
    }

    _removeTimeout() {
        if (this._timeoutId != 0) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
});

var PrintNotification = GObject.registerClass(
    class PrintNotification extends GObject.Object {

    _init(printOp, doc) {
        this.widget = null;
        this._printOp = printOp;
        this._doc = doc;

        this._printOp.connect('begin-print',
                              Lang.bind(this, this._onPrintBegin));
        this._printOp.connect('status-changed',
                              Lang.bind(this, this._onPrintStatus));
    }

    _onPrintBegin() {
        this.widget = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                     row_spacing: 6 });

        this._statusLabel = new Gtk.Label();
        this.widget.add(this._statusLabel);
        this._progressBar = new Gtk.ProgressBar();
        this.widget.add(this._progressBar);

        this._stopButton = new Gtk.Button({ image: new Gtk.Image({ icon_name: 'process-stop-symbolic',
                                                                   pixel_size: 16,
                                                                   margin_top: 2,
                                                                   margin_bottom: 2 }),
                                            margin_start: 12,
                                            valign: Gtk.Align.CENTER
                                            });
        this.widget.attach_next_to(this._stopButton, this._statusLabel,
                                   Gtk.PositionType.RIGHT, 1, 2);
        this._stopButton.connect('clicked', Lang.bind(this,
            function() {
                this._printOp.cancel();
                this.widget.destroy();
            }));

        Application.notificationManager.addNotification(this);
    }

    _onPrintStatus() {
        if (!this.widget)
            return;

        let status = this._printOp.get_status();
        let fraction = this._printOp.get_progress();
        status = _("Printing “%s”: %s").format(this._doc.name, status);

        this._statusLabel.set_text(status);
        this._progressBar.fraction = fraction;

        if (fraction == 1)
            this.widget.destroy();
    }
});

const REMOTE_MINER_TIMEOUT = 10; // seconds
const TRACKER_MINER_FILES_NAME = 'org.freedesktop.Tracker1.Miner.Files';

const IndexingNotification = GObject.registerClass(
    class IndexingNotification extends GObject.Object {

    _init() {
        this._closed = false;
        this._timeoutId = 0;

        try {
            this._manager = TrackerControl.MinerManager.new_full(false);
            this._manager.connect('miner-progress', Lang.bind(this, this._checkNotification));
        } catch(e) {
            logError(e, 'Unable to create a TrackerMinerManager, indexing progress ' +
                     'notification won\'t work');
            return;
        }

        Application.application.connect('miners-changed', Lang.bind(this, this._checkNotification));
        Application.modeController.connect('window-mode-changed', Lang.bind(this, this._checkNotification));
    }

    _checkNotification() {
        if (Application.modeController.getWindowMode() == WindowMode.WindowMode.PREVIEW_EV) {
            this._destroy(false);
            return;
        }

        let isIndexingLocal = false;
        let isIndexingRemote = false;

        if (this._manager) {
            let running = this._manager.get_running();
            if (running.indexOf(TRACKER_MINER_FILES_NAME) != -1) {
                let [res, status, progress, time] = this._manager.get_status(TRACKER_MINER_FILES_NAME);

                if (progress < 1)
                    isIndexingLocal = true;
            }
        }

        if (Application.application.minersRunning.length > 0)
            isIndexingRemote = true;

        if (isIndexingLocal) {
            this._display(_("Your documents are being indexed"),
                          _("Some documents might not be available during this process"));
        } else if (isIndexingRemote) {
            this._removeTimeout();
            this._timeoutId = Mainloop.timeout_add_seconds(REMOTE_MINER_TIMEOUT, Lang.bind(this, this._onTimeoutExpired));
        } else {
            this._destroy(false);
        }
    }

    _onTimeoutExpired() {
        this._timeoutId = 0;

        let primary = null;
        let miner = null;

        if (Application.application.minersRunning.length == 1) {
            miner = Application.application.minersRunning[0];
        }

        if (miner && miner.DisplayName) {
            // Translators: %s refers to an online account provider, e.g.
            // "Google", or "Windows Live".
            primary = _("Fetching documents from %s").format(miner.DisplayName);
        } else {
            primary = _("Fetching documents from online accounts");
        }

        this._display(primary, null);

        return false;
    }

    _removeTimeout() {
        if (this._timeoutId != 0) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _buildWidget() {
        this.widget = new Gtk.Grid({ orientation: Gtk.Orientation.HORIZONTAL,
                                     column_spacing: 12 });

        let spinner = new Gtk.Spinner({ width_request: 16,
                                        height_request: 16 });
        spinner.start();
        this.widget.add(spinner);

        let labels = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    row_spacing: 3 });
        this.widget.add(labels);

        this._primaryLabel = new Gtk.Label({ halign: Gtk.Align.START });
        labels.add(this._primaryLabel);

        this._secondaryLabel = new Gtk.Label({ halign: Gtk.Align.START });
        this._secondaryLabel.get_style_context().add_class('dim-label');
        labels.add(this._secondaryLabel);

        let close = new Gtk.Button({ image: new Gtk.Image({ icon_name: 'window-close-symbolic',
                                                            pixel_size: 16,
                                                            margin_top: 2,
                                                            margin_bottom: 2 }),
                                     valign: Gtk.Align.CENTER,
                                     focus_on_click: false,
                                     relief: Gtk.ReliefStyle.NONE });
        close.connect('clicked', Lang.bind(this,
            function() {
                this._destroy(true);
            }));
        this.widget.add(close);

        Application.notificationManager.addNotification(this);
    }

    _update(primaryText, secondaryText) {
        this._primaryLabel.label = primaryText;
        this._secondaryLabel.label = secondaryText;

        if (secondaryText) {
            this._primaryLabel.vexpand = false;
            this._secondaryLabel.show();
        } else {
            this._primaryLabel.vexpand = true;
            this._secondaryLabel.hide();
        }
    }

    _display(primaryText, secondaryText) {
        if (this._closed) {
            return;
        }

        if (!this.widget)
            this._buildWidget();

        this._update(primaryText, secondaryText);
    }

    _destroy(closed) {
        this._removeTimeout();

        if (this.widget) {
            this.widget.destroy();
            this.widget = null;
        }

        this._closed = closed;
    }
});

var NotificationManager = GObject.registerClass(
    class NotificationManager extends Gtk.Revealer {

    _init() {
        super._init({ halign: Gtk.Align.CENTER,
                      valign: Gtk.Align.START });

        let frame = new Gtk.Frame();
        frame.get_style_context().add_class('app-notification');
        this.add(frame);

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    row_spacing: 6 });

        frame.add(this._grid);

        // add indexing monitor notification
        this._indexingNotification = new IndexingNotification();
    }

    addNotification(notification) {
        this._grid.add(notification.widget);
        notification.widget.connect('destroy', Lang.bind(this, this._onWidgetDestroy));

        this.show_all();
        this.reveal_child = true;
    }

    _onWidgetDestroy() {
        let children = this._grid.get_children();

        if (children.length == 0)
            this.reveal_child = false;
    }
});
