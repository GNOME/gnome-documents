/*
 * Copyright(c) 2012 Meg Ford
 *
 * Except for _isValidEmail(), adapted from:
 * http://rosskendall.com/files/rfc822validemail.js.txt
 * with GPLv2+ license and the following copyright header.
 *
 * ====
 *
 * JavaScript function to check an email address conforms to RFC822 (http://www.ietf.org/rfc/rfc0822.txt)
 *
 * Version: 0.2
 * Author: Ross Kendall
 * Created: 2006-12-16
 * Updated: 2007-03-22
 *
 * Based on the PHP code by Cal Henderson
 * http://iamcal.com/publish/articles/php/parsing_email/
 * Portions copyright (C) 2006  Ross Kendall - http://rosskendall.com
 * Portions copyright (C) 1993-2005 Cal Henderson - http://iamcal.com
 *
 * ====
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
 * Author: Meg Ford <megford@gnome.org>
 *
 */

const Gd = imports.gi.Gd;
const GData = imports.gi.GData;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const _ = imports.gettext.gettext;

const Application = imports.application;

const Lang = imports.lang;

const SharingDialogColumns = {
    NAME: 0,
    ROLE: 1
};

const DocumentShareState = {
    UNKNOWN: 0,
    PUBLIC: 1,
    PRIVATE: 2
};

const DocumentUpdateType = {
    NONE: 0,
    ADD_PUBLIC: 1,
    DELETE_PUBLIC: 2,
    CHANGE_PUBLIC: 3,
    DELETE_SHARE_LINK: 4
};

var SharingDialog = GObject.registerClass(
    class SharingDialog extends Gtk.Dialog {

    _init() {
        let urn = Application.selectionController.getSelection();
        this._doc = Application.documentManager.getItemById(urn);

        let source = Application.sourceManager.getItemById(this._doc.resourceUrn);
        let authorizer = new GData.GoaAuthorizer({ goa_object: source.object });
        this._service = new GData.DocumentsService({ authorizer: authorizer });

        this._entry = null;
        this._feed = null;

        this._doc.createGDataEntry(null, Lang.bind(this,
            function(entry, service, exception) {
                if (exception) {
                    logError(exception, 'Error getting GData Entry');
                    return;
                }
                this._entry = entry;
                this._refreshEntryACL();
            }));

        this._docShare = DocumentShareState.UNKNOWN;
        this._pubEdit = false;
        this._changePermissionVisible = false;

        let toplevel = Application.application.get_windows()[0];
        super._init({ resizable: false,
                      transient_for: toplevel,
                      modal: true,
                      destroy_with_parent: true,
                      use_header_bar: true,
                      width_request: 335,
                      margin_top: 5,
                      title: _("Sharing Settings"),
                      hexpand: true });

        // Label for Done button in Sharing dialog
        this.add_button(_("Done"), Gtk.ResponseType.CLOSE);

        let mainGrid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                      column_spacing: 6,
                                      row_spacing: 6,
                                      margin_start: 12,
                                      margin_end: 12 });
        let contentArea = this.get_content_area();
        contentArea.pack_start(mainGrid, true, true, 0);

        this._scrolledWin = new Gtk.ScrolledWindow({ shadow_type: Gtk.ShadowType.IN,
                                                     margin_bottom: 3,
                                                     hexpand: true,
                                                     vexpand: true,
                                                     width_request: 250,
                                                     height_request: 250 });
        mainGrid.add(this._scrolledWin);

        let spinner = new Gtk.Spinner ({ active: true,
                                         halign: Gtk.Align.CENTER,
                                         width_request: 86,
                                         height_request: 86 });
        this._scrolledWin.add_with_viewport(spinner);

        this._grid = new Gtk.Grid({ orientation: Gtk.Orientation.VERTICAL,
                                    hexpand: true,
                                    vexpand: true,
                                    column_spacing: 6,
                                    row_spacing: 6,
                                    margin_bottom: 12 });
        mainGrid.add(this._grid);

        // Label for widget group for changing document permissions
        let label = new Gtk.Label ({ label: '<b>' + _("Document permissions") + '</b>',
                                     halign: Gtk.Align.START,
                                     use_markup: true,
                                     hexpand: false });
        this._grid.add(label);

        // Label for permission change in Sharing dialog
        this._changeButton = new Gtk.Button({ label: _("Change"),
                                              sensitive: false,
                                              halign: Gtk.Align.END });
        this._changeButton.connect("clicked", Lang.bind(this, this._onPermissionsButtonClicked));
        this._grid.attach(this._changeButton, 2, 0, 1, 1);

        let settingBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                       spacing: 24,
                                       margin_bottom: 6,
                                       hexpand: true });
        this._grid.add(settingBox);
        this._grid.child_set_property(settingBox, 'width', 3);

        // Labels showing the current privacy setting for the document
        this._setting = new Gtk.Label({ halign: Gtk.Align.START,
                                        no_show_all: true });
        settingBox.add(this._setting);

        this._settingDetail = new Gtk.Label({ halign: Gtk.Align.START,
                                              no_show_all: true });
        this._settingDetail.get_style_context().add_class('dim-label');
        settingBox.add(this._settingDetail);

        // Label for radiobutton that sets doc permission to private
        this._privateRadio = new Gtk.RadioButton({ label: _("Private") });
        this._grid.add(this._privateRadio);

        this._publicBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL,
                                        spacing: 24 });
        this._grid.add(this._publicBox);
        this._grid.child_set_property(this._publicBox, 'width', 3);

        // Label for radiobutton that sets doc permission to Public
        this._publicRadio =  new Gtk.RadioButton({ group: this._privateRadio,
                                                   label: _("Public") });
        this._publicBox.add(this._publicRadio);

        // Label for checkbutton that sets doc permission to Can edit
        this._pubEditCheck = new Gtk.CheckButton({ label: _("Everyone can edit"),
                                                   sensitive: false,
                                                   halign: Gtk.Align.START });
        this._publicBox.add(this._pubEditCheck);
        this._publicRadio.bind_property('active', this._pubEditCheck, 'sensitive', GObject.BindingFlags.DEFAULT);

        // Label for widget group used for adding new contacts
        label = new Gtk.Label ({ label: '<b>' +  _("Add people") + '</b>',
                                 halign: Gtk.Align.START,
                                 use_markup: true,
                                 hexpand: false });
        this._grid.add(label);

        // Editable text in entry field
        this._contactEntry = new Gtk.Entry({ placeholder_text: _("Enter an email address"),
                                             no_show_all: true,
                                             hexpand: true,
                                             halign: Gtk.Align.START });
        this._contactEntry.connect('changed', Lang.bind(this,
            function() {
                let hasText = !!this._isValidEmail();
                this._saveShare.sensitive = hasText;
                this._comboBoxText.sensitive = hasText;
            }));
        this._grid.add(this._contactEntry);

        // Permission setting labels in combobox
        this._comboBoxText = new Gtk.ComboBoxText({ sensitive: false,
                                                    no_show_all: true });
        let combo = [_("Can edit"), _("Can view") ];
        for (let i = 0; i < combo.length; i++)
            this._comboBoxText.append_text(combo[i]);

        this._comboBoxText.set_active(0);
        this._grid.attach_next_to(this._comboBoxText, this._contactEntry, Gtk.PositionType.RIGHT, 1, 1);

        this._saveShare = new Gtk.Button({ label: _("Add"),
                                           no_show_all: true,
                                           sensitive: false });
        this._saveShare.connect ('clicked', Lang.bind(this, this._onAddClicked));
        this._grid.attach_next_to(this._saveShare, this._comboBoxText, Gtk.PositionType.RIGHT, 1, 1);

        this._noPermission = new Gtk.Label({ halign: Gtk.Align.START,
                                             no_show_all: true,
                                             hexpand: true });
        this._grid.add(this._noPermission);
        this._grid.child_set_property(this._noPermission, 'width', 3);

        this.show_all();
        this._updatePermissionButtons();
    }

    _ensureTreeview() {
        if (this._model) {
            this._model.clear();
            return;
        }

        this._model = Gtk.ListStore.new([GObject.TYPE_STRING, GObject.TYPE_STRING]);
        this._treeView = new Gtk.TreeView({ headers_visible: false,
                                            vexpand: true,
                                            hexpand: true });
        this._treeView.set_model(this._model);
        this._treeView.show();

        let col = new Gtk.TreeViewColumn();
        this._treeView.append_column(col);

        // Name column
        let cell = new Gtk.CellRendererText({ xpad: 6,
                                              ypad: 4 });
        col.pack_start(cell, true);
        col.add_attribute(cell, 'text', SharingDialogColumns.NAME);

        // Role column
        cell = new Gd.StyledTextRenderer({ xpad: 16 });
        cell.add_class('dim-label');
        col.pack_start(cell, false);
        col.add_attribute(cell, 'text', SharingDialogColumns.ROLE);

        let child = this._scrolledWin.get_child();
        if (child)
            child.destroy();
        this._scrolledWin.add(this._treeView);
    }

    _onPermissionsButtonClicked() {
        this._changePermissionVisible = !this._changePermissionVisible;
        if (!this._changePermissionVisible) {
            this._changeButton.set_sensitive(false);
            this._sendNewDocumentRule();
        }

        this._updatePermissionButtons();
    }

    _permissionChangeFinished() {
        this._changePermissionVisible = false;
        this._changeButton.set_sensitive(true);
        this._updatePermissionButtons();
    }

    _updateSettingString() {
        let primary = '';
        let detail = '';

        switch (this._docShare) {
        case DocumentShareState.PUBLIC:
            primary = _("Public");
            if (this._pubEdit)
                detail = _("Everyone can edit");
            else
                detail = _("Everyone can read");
            break;
        case DocumentShareState.PRIVATE:
            primary = _("Private");
            break;
        default:
            break;
        }

        this._setting.label = primary;
        this._settingDetail.label = detail;
    }

    _updatePermissionButtons() {
        if (this._changePermissionVisible) {
            this._changeButton.label = _("Save");
            this._setting.hide();
            this._settingDetail.hide();

            this._privateRadio.show();
            this._pubEditCheck.active = this._pubEdit;
            this._publicBox.show_all();

            if (this._docShare == DocumentShareState.PUBLIC)
                this._publicRadio.set_active(true);
            else if (this._docShare == DocumentShareState.PRIVATE)
                this._privateRadio.set_active(true);
        } else {
            this._changeButton.label = _("Change");
            this._setting.show();
            this._settingDetail.show();

            this._privateRadio.hide();
            this._publicBox.hide();
        }
    }

    // Return a feed containing the acl related to the entry
    _refreshEntryACL() {
        this._entry.get_rules_async(this._service, null, null, Lang.bind(this,
            function(entry, result) {
                try {
                    this._feed = this._service.query_finish(result);
                    this._getScopeRulesEntry();
                } catch(e) {
                    logError(e, 'Error getting ACL Feed');
                }
            }));
    }

    _getAccountNames() {
        let retval = [];
        let sources = Application.sourceManager.getForProviderType('google');

        sources.forEach(Lang.bind(this,
            function(source) {
                let account = source.object.get_account();
                retval.push(account.identity);
            }));

        return retval;
    }

    // Get the roles, and make a new array containing strings that start with capital letters
    _getUserRoleString(role) {
        if (role.charAt(0) == 'o')
            return _("Owner"); // Owner permission for document user listed in treeview

        if (role.charAt(0) == 'w')
            return _("Can edit"); // Writer permission for document user listed in treeview

        if (role.charAt(0) == 'r')
            return _("Can view"); // Reader permission for document user listed in treeview

        return '';
    }

    // Get each entry (person) from the feed, and get the scope for each person, and then store the emails and values in an array
    _getScopeRulesEntry() {
        let entries = this._feed.get_entries();
        let accountNames = this._getAccountNames();

        let allowChanges = false;
        let values = [];
        let ownerId = null;
        let pubEdit = false;
        let docShare = DocumentShareState.PRIVATE;

        entries.forEach(Lang.bind(this,
            function(entry) {
                let [type, value] = entry.get_scope();
                let role = entry.get_role();

                if (value != null) {
                    values.push({ name: value, role: this._getUserRoleString(role) });

                    if ((accountNames.indexOf(value) != -1) &&
                        (role == GData.DOCUMENTS_ACCESS_ROLE_WRITER || role == GData.DOCUMENTS_ACCESS_ROLE_OWNER))
                        allowChanges = true;
                } else {
                    if (role != GData.ACCESS_ROLE_NONE)
                        docShare = DocumentShareState.PUBLIC;
                    if (role == GData.DOCUMENTS_ACCESS_ROLE_WRITER)
                        pubEdit = true;
                }

                if (role == GData.DOCUMENTS_ACCESS_ROLE_OWNER)
                   ownerId = value;
             }));

        this._ensureTreeview();

        // Set values in the treemodel
        values.forEach(Lang.bind (this,
            function(value) {
                let iter = this._model.append();
                this._model.set(iter,
                    [SharingDialogColumns.NAME, SharingDialogColumns.ROLE],
                    [value.name, value.role]);
            }));

        // Propagate new state
        this._docShare = docShare;
        this._pubEdit = pubEdit;
        this._updateSettingString();

        if (allowChanges) {
            this._changeButton.set_sensitive(true);
            this._noPermission.hide();

            this._contactEntry.show();
            this._comboBoxText.show();
            this._saveShare.show();
        } else {
            this._noPermission.show();
            this._noPermission.set_text(_("You can ask %s for access").format(ownerId));
        }
    }

    // Get the role for the new contact from the combobox
    _getNewContactRule() {
        let activeItem = this._comboBoxText.get_active();
        let role;

        if (activeItem == 0)
            role = GData.DOCUMENTS_ACCESS_ROLE_WRITER;
        else if (activeItem == 1)
            role = GData.DOCUMENTS_ACCESS_ROLE_READER;

        return new GData.AccessRule({ role: role,
                                      scope_type: GData.ACCESS_SCOPE_USER,
                                      scope_value: this._contactEntry.get_text() });
    }

    // Send the new contact and its permissions to Google Docs
    _onAddClicked() {
        let accessRule = this._getNewContactRule();
        let aclLink = this._entry.look_up_link(GData.LINK_ACCESS_CONTROL_LIST);

        this._contactEntry.set_sensitive(false);

        this._service.insert_entry_async(GData.DocumentsService.get_primary_authorization_domain(),
            aclLink.get_uri(), accessRule, null, Lang.bind(this,
                function(service, res) {
                    this._contactEntry.set_sensitive(true);
                    this._contactEntry.set_text('');

                    try {
                        this._service.insert_entry_finish(res);
                        this._refreshEntryACL();
                    } catch(e) {
                        logError(e, 'Error inserting new ACL rule');
                        this._showErrorDialog(_("The document was not updated"));
                    }
                }));
    }

    // Get the scope from the radiobuttons
    _getNewScopeType() {
        let scope = GData.ACCESS_SCOPE_USER;
        if (this._publicRadio.get_active())
            scope = GData.ACCESS_SCOPE_DEFAULT;

        return scope;
    }

    // Get the role from the checkbox
    _getNewRole() {
        let role = GData.DOCUMENTS_ACCESS_ROLE_READER;
        if (this._pubEditCheck.get_active())
            role = GData.DOCUMENTS_ACCESS_ROLE_WRITER;

        return role;
    }

    _insertNewPermission(scopeType, role) {
        let aclLink = this._entry.look_up_link(GData.LINK_ACCESS_CONTROL_LIST);
        let accessRule = new GData.AccessRule({ scope_type: scopeType,
                                                role: role });

        this._service.insert_entry_async(GData.DocumentsService.get_primary_authorization_domain(),
            aclLink.get_uri(), accessRule, null, Lang.bind(this,
                function(service, res) {
                    try {
                        service.insert_entry_finish(res);
                        this._refreshEntryACL();
                    } catch(e) {
                        logError(e, 'Error inserting new ACL scope for document');
                        this._showErrorDialog(_("The document was not updated"));
                    }

                    this._permissionChangeFinished();
                }));
    }

    _sendNewDocumentRule() {
        let newScopeType = this._getNewScopeType();
        let newRole = this._getNewRole();
        let entries = this._feed.get_entries();
        let updateType = DocumentUpdateType.NONE;
        let idx = 0;

        for (idx = 0; idx < entries.length; idx++) {
            let entry = entries[idx];
            let [type, value] = entry.get_scope();
            let role = entry.get_role();

            if (type != GData.ACCESS_SCOPE_DEFAULT)
                continue;

            if (newScopeType == GData.ACCESS_SCOPE_USER)
                updateType = DocumentUpdateType.DELETE_PUBLIC;
            else if ((role != newRole) && (role != GData.ACCESS_ROLE_NONE))
                updateType = DocumentUpdateType.CHANGE_PUBLIC;
            else if (role == GData.ACCESS_ROLE_NONE)
                updateType = DocumentUpdateType.DELETE_SHARE_LINK;

            break;
        }

        if ((updateType == DocumentUpdateType.NONE) && (idx == entries.length)
            && (newScopeType == GData.ACCESS_SCOPE_DEFAULT))
            updateType = DocumentUpdateType.ADD_PUBLIC;

        if (updateType == DocumentUpdateType.NONE) {
            this._permissionChangeFinished();
            return;
        }

        if (updateType == DocumentUpdateType.ADD_PUBLIC) {
            // If we are making the doc public, send a new permission
            this._insertNewPermission(newScopeType, newRole);
        } else if (updateType == DocumentUpdateType.CHANGE_PUBLIC) {
            // If we are changing the role, update the entry
            let accessRule = entries[idx];
            accessRule.set_role(newRole);

            this._service.update_entry_async(GData.DocumentsService.get_primary_authorization_domain(),
                accessRule, null, Lang.bind(this,
                    function(service, res) {
                        try {
                            service.update_entry_finish(res);
                            this._refreshEntryACL();
                        } catch(e) {
                            logError(e, 'Error updating ACL scope for document');
                            this._showErrorDialog(_("The document was not updated"));
                        }

                        this._permissionChangeFinished();
                    }));
        } else if (updateType == DocumentUpdateType.DELETE_PUBLIC) {
            // If we are changing the permission to private, delete the public entry.
            let accessRule = entries[idx];

            this._service.delete_entry_async(GData.DocumentsService.get_primary_authorization_domain(),
                accessRule, null, Lang.bind(this,
                    function(service, res) {
                        try {
                            service.delete_entry_finish(res);
                            this._refreshEntryACL();
                        } catch(e) {
                            logError(e, 'Error deleting ACL scope for document');
                            this._showErrorDialog(_("The document was not updated"));
                        }

                        this._permissionChangeFinished();
                    }));
        } else if (updateType == DocumentUpdateType.DELETE_SHARE_LINK) {
            // Workaround if the doc is shared with link: step 1 delete shared with link permission.
            let accessRule = entries[idx];

            this._service.delete_entry_async(GData.DocumentsService.get_primary_authorization_domain(),
                accessRule, null, Lang.bind(this,
                    function(service, res) {
                        try {
                            service.delete_entry_finish(res);

                            // Workaround if the doc is shared with link: step 2 add the new public permisssion.
                            this._insertNewPermission(newScopeType, newRole);
                        } catch(e) {
                            logError(e, 'Error deleting ACL scope for document');
                            this._showErrorDialog(_("The document was not updated"));
                        }
                    }));
        }
    }

    _isValidEmail() {
        let emailString = this._contactEntry.get_text();
        // Use Ross Kendell's RegEx to check for valid email address
        return /^([^\x00-\x20\x22\x28\x29\x2c\x2e\x3a-\x3c\x3e\x40\x5b-\x5d\x7f-\xff]+|\x22([^\x0d\x22\x5c\x80-\xff]|\x5c[\x00-\x7f])*\x22)(\x2e([^\x00-\x20\x22\x28\x29\x2c\x2e\x3a-\x3c\x3e\x40\x5b-\x5d\x7f-\xff]+|\x22([^\x0d\x22\x5c\x80-\xff]|\x5c[\x00-\x7f])*\x22))*\x40([^\x00-\x20\x22\x28\x29\x2c\x2e\x3a-\x3c\x3e\x40\x5b-\x5d\x7f-\xff]+|\x5b([^\x0d\x5b-\x5d\x80-\xff]|\x5c[\x00-\x7f])*\x5d)(\x2e([^\x00-\x20\x22\x28\x29\x2c\x2e\x3a-\x3c\x3e\x40\x5b-\x5d\x7f-\xff]+|\x5b([^\x0d\x5b-\x5d\x80-\xff]|\x5c[\x00-\x7f])*\x5d))*$/.test(emailString);
    }

    _showErrorDialog(errorStr) {
        let errorDialog = new Gtk.MessageDialog ({ transient_for: this,
                                                   modal: true,
                                                   destroy_with_parent: true,
                                                   buttons: Gtk.ButtonsType.OK,
                                                   message_type: Gtk.MessageType.WARNING,
                                                   text: errorStr });

        errorDialog.connect ('response', Lang.bind(this,
            function() {
                errorDialog.destroy();
            }));
        errorDialog.show();
    }
});
