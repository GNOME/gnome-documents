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

const Application = imports.application;
const Documents = imports.documents;
const Manager = imports.manager;
const Query = imports.query;

const Signals = imports.signals;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Tracker = imports.gi.Tracker;
const _ = imports.gettext.gettext;
const C_ = imports.gettext.pgettext;

function initSearch(context) {
    context.documentManager = new Documents.DocumentManager();
    context.sourceManager = new SourceManager(context);
    context.searchMatchManager = new SearchMatchManager(context);
    context.searchTypeManager = new SearchTypeManager(context);
    context.searchController = new SearchController(context);
    context.queryBuilder = new Query.QueryBuilder(context);
};

const SearchState = class SearchState {
    constructor(searchMatch, searchType, source, str) {
        this.searchMatch = searchMatch;
        this.searchType = searchType;
        this.source = source;
        this.str = str;
    }
}

const SearchController = class SearchController {
    constructor() {
        this._string = '';
    }

    setString(string) {
        if (this._string == string)
            return;

        this._string = string;
        this.emit('search-string-changed', this._string);
    }

    getString() {
        return this._string;
    }

    getTerms() {
        let escapedStr = Tracker.sparql_escape_string(this._string);
        let [tokens, ] = GLib.str_tokenize_and_fold(escapedStr, null);
        return tokens;
    }
}
Signals.addSignalMethods(SearchController.prototype);

const SearchType = class SearchType {
    constructor(params) {
        this.id = params.id;
        this.name = params.name;
        this._filter = (params.filter) ? (params.filter) : '(true)';
        this._where = (params.where) ? (params.where) : '';
    }

    getFilter() {
        return this._filter;
    }

    getWhere() {
        return this._where;
    }
}

var SearchTypeStock = {
    ALL: 'all',
    COLLECTIONS: 'collections',
    PDF: 'pdf',
    PRESENTATIONS: 'presentations',
    SPREADSHEETS: 'spreadsheets',
    TEXTDOCS: 'textdocs'
};

const SearchTypeManager = class SearchTypeManager extends Manager.BaseManager {
    constructor(context) {
        // Translators: "Type" refers to a search filter on the document type
        // (PDF, spreadsheet, ...)
        super(C_("Search Filter", "Type"), 'search-type', context);

        this.addItem(new SearchType({ id: SearchTypeStock.ALL,
                                      name: _("All") }));
        this.addItem(new SearchType({ id: SearchTypeStock.COLLECTIONS,
                                      name: _("Collections"),
                                      filter: 'fn:starts-with(nao:identifier(?urn), \"gd:collection\")',
                                      where: '?urn rdf:type nfo:DataContainer .' }));
        this.addItem(new SearchType({ id: SearchTypeStock.PDF,
                                      name: _("PDF Documents"),
                                      filter: 'fn:contains(nie:mimeType(?urn), \"application/pdf\")',
                                      where: '?urn rdf:type nfo:PaginatedTextDocument .' }));

        this.addItem(new SearchType({ id: SearchTypeStock.PRESENTATIONS,
                                      name: _("Presentations"),
                                      where: '?urn rdf:type nfo:Presentation .' }));
        this.addItem(new SearchType({ id: SearchTypeStock.SPREADSHEETS,
                                      name: _("Spreadsheets"),
                                      where: '?urn rdf:type nfo:Spreadsheet .' }));
        this.addItem(new SearchType({ id: SearchTypeStock.TEXTDOCS,
                                      name: _("Text Documents"),
                                      filter: 'NOT EXISTS { ?urn a nfo:EBook }',
                                      where: '?urn rdf:type nfo:PaginatedTextDocument .' }));

        this.setActiveItemById(SearchTypeStock.ALL);
    }

    getCurrentTypes() {
        let activeItem = this.getActiveItem();

        if (activeItem.id == SearchTypeStock.ALL)
            return this.getAllTypes();

        return [ activeItem ];
    }

    getDocumentTypes() {
        let types = [];

        types.push(this.getItemById(SearchTypeStock.PDF));
        types.push(this.getItemById(SearchTypeStock.PRESENTATIONS));
        types.push(this.getItemById(SearchTypeStock.SPREADSHEETS));
        types.push(this.getItemById(SearchTypeStock.TEXTDOCS));

        return types;
    }

    getAllTypes() {
        let types = [];

        this.forEachItem(function(item) {
            if (item.id != SearchTypeStock.ALL)
                types.push(item);
            });

        return types;
    }
}

var SearchMatchStock = {
    ALL: 'all',
    TITLE: 'title',
    AUTHOR: 'author',
    CONTENT: 'content'
};

const SearchMatch = class SearchMatch {
    constructor(params) {
        this.id = params.id;
        this.name = params.name;
        this._term = '';
    }

    setFilterTerm(term) {
        this._term = term;
    }

    getFilter() {
        if (this.id == SearchMatchStock.TITLE)
            return ('fn:contains ' +
                    '(tracker:unaccent(tracker:case-fold' +
                    '(tracker:coalesce(nie:title(?urn), nfo:fileName(?urn)))), ' +
                    '"%s") || ' +
                    'fn:contains ' +
                    '(tracker:case-fold' +
                    '(tracker:coalesce(nie:title(?urn), nfo:fileName(?urn))), ' +
                    '"%s")').format(this._term, this._term);
        if (this.id == SearchMatchStock.AUTHOR)
            return ('fn:contains ' +
                    '(tracker:unaccent(tracker:case-fold' +
                    '(tracker:coalesce(nco:fullname(?creator), nco:fullname(?publisher)))), ' +
                    '"%s") || ' +
                    'fn:contains ' +
                    '(tracker:case-fold' +
                    '(tracker:coalesce(nco:fullname(?creator), nco:fullname(?publisher))), ' +
                    '"%s")').format(this._term, this._term);
        if (this.id == SearchMatchStock.CONTENT)
            return '(false)';
        return '';
    }
}

const SearchMatchManager = class SearchMatchManager extends Manager.BaseManager {
    constructor(context) {
        // Translators: this is a verb that refers to "All", "Title", "Author",
        // and "Content" as in "Match All", "Match Title", "Match Author", and
        // "Match Content"
        super(_("Match"), 'search-match', context);

        this.addItem(new SearchMatch({ id: SearchMatchStock.ALL,
                                       name: _("All") }));
        this.addItem(new SearchMatch({ id: SearchMatchStock.TITLE,
        //Translators: "Title" refers to "Match Title" when searching
                                       name: C_("Search Filter", "Title") }));
        this.addItem(new SearchMatch({ id: SearchMatchStock.AUTHOR,
        //Translators: "Author" refers to "Match Author" when searching
                                       name: C_("Search Filter", "Author") }));
        this.addItem(new SearchMatch({ id: SearchMatchStock.CONTENT,
        //Translators: "Content" refers to "Match Content" when searching
                                       name: C_("Search Filter", "Content") }));

        this.setActiveItemById(SearchMatchStock.ALL);
    }

    getWhere() {
        let item = this.getActiveItem();
        if (item.id != SearchMatchStock.ALL &&
            item.id != SearchMatchStock.CONTENT)
            return '';

        let terms = this.context.searchController.getTerms();
        if (!terms.length)
            return '';

        let ftsterms = [];
        for (let i = 0; i < terms.length; i++) {
            if (terms[i].length > 0)
                ftsterms.push(terms[i] + '*');
        }

        return '?urn fts:match \'%s\' . '.format(ftsterms.join(' '));
    }

    getFilter(flags) {
        if ((flags & Query.QueryFlags.SEARCH) == 0)
            return '(true)';

        let terms = this.context.searchController.getTerms();
        let filters = [];

        for (let i = 0; i < terms.length; i++) {
            this.forEachItem(function(item) {
                item.setFilterTerm(terms[i]);
            });

            let filter;
            let item = this.getActiveItem();

            if (item.id == SearchMatchStock.ALL)
                filter = this.getAllFilter();
            else
                filter = item.getFilter();

            filters.push(filter);
        }
        return filters.length ? '( ' + filters.join(' && ') + ')' : '(true)';
    }
}

var SearchSourceStock = {
    ALL: 'all',
    LOCAL: 'local'
};

const TRACKER_SCHEMA = 'org.freedesktop.Tracker.Miner.Files';
const TRACKER_KEY_RECURSIVE_DIRECTORIES = 'index-recursive-directories';

const Source = class Source {
    constructor(params) {
        this.id = null;
        this.name = null;
        this.icon = null;

        if (params.object) {
            this.object = params.object;
            let account = params.object.get_account();

            this.id = 'gd:goa-account:' + account.id;
            this.name = account.provider_name;
            this.icon = Gio.icon_new_for_string(account.provider_icon);
        } else {
            this.id = params.id;
            this.name = params.name;
        }

        this.builtin = params.builtin;
    }

    _getGettingStartedLocations() {
        if (Application.application.gettingStartedLocation)
            return Application.application.gettingStartedLocation;
        else
            return [];
    }

    _getTrackerLocations() {
        let settings = new Gio.Settings({ schema_id: TRACKER_SCHEMA });
        let locations = settings.get_strv(TRACKER_KEY_RECURSIVE_DIRECTORIES);
        let files = [];

        locations.forEach((location) => {
            // ignore special XDG placeholders, since we handle those internally
            if (location[0] == '&' || location[0] == '$')
                return;

            let trackerFile = Gio.file_new_for_commandline_arg(location);

            // also ignore XDG locations if they are present with their full path
            for (let idx = 0; idx < GLib.UserDirectory.N_DIRECTORIES; idx++) {
                let path = GLib.get_user_special_dir(idx);
                if (!path)
                    continue;

                let file = Gio.file_new_for_path(path);
                if (trackerFile.equal(file))
                    return;
            }

            files.push(trackerFile);
        });

        return files;
    }

    _getBuiltinLocations() {
        let files = [];
        let xdgDirs = [GLib.UserDirectory.DIRECTORY_DESKTOP,
                       GLib.UserDirectory.DIRECTORY_DOCUMENTS,
                       GLib.UserDirectory.DIRECTORY_DOWNLOAD];

        xdgDirs.forEach((dir) => {
            let path = GLib.get_user_special_dir(dir);
            if (path)
                files.push(Gio.file_new_for_path(path));
        });

        return files;
    }

    _buildFilterLocal() {
        let locations = this._getBuiltinLocations();
        locations = locations.concat(
            this._getTrackerLocations(),
            this._getGettingStartedLocations());

        let filters = [];
        locations.forEach((location) => {
            filters.push('(fn:contains (nie:url(?urn), "%s"))'.format(location.get_uri()));
        });

        filters.push('(fn:starts-with (nao:identifier(?urn), "gd:collection:local:"))');

        return '(' + filters.join(' || ') + ')';
    }

    getFilter() {
        let filters = [];

        if (this.id == SearchSourceStock.LOCAL) {
            filters.push(this._buildFilterLocal());
        } else if (this.id == SearchSourceStock.ALL) {
            filters.push(this._buildFilterLocal());
            filters.push(this._manager.getFilterNotLocal());
        } else {
            filters.push(this._buildFilterResource());
        }

        return '(' + filters.join(' || ') + ')';
    }

    _buildFilterResource() {
        let filter = '(false)';

        if (!this.builtin)
            filter = ('(nie:dataSource(?urn) = "%s")').format(this.id);

        return filter;
    }
}

const SourceManager = class SourceManager extends Manager.BaseManager {
    constructor(context) {
        super(_("Sources"), 'search-source', context);

        let source = new Source({ id: SearchSourceStock.ALL,
        // Translators: this refers to documents
                                  name: _("All"),
                                  builtin: true });
        this.addItem(source);

        source = new Source({ id: SearchSourceStock.LOCAL,
        // Translators: this refers to local documents
                              name: _("Local"),
                              builtin: true });
        this.addItem(source);

        Application.goaClient.connect('account-added', this._refreshGoaAccounts.bind(this));
        Application.goaClient.connect('account-changed', this._refreshGoaAccounts.bind(this));
        Application.goaClient.connect('account-removed', this._refreshGoaAccounts.bind(this));

        this._refreshGoaAccounts();

        this.setActiveItemById(SearchSourceStock.ALL);
    }

    _refreshGoaAccounts() {
        let newItems = {};
        let newSources = new Map();
        let accounts = Application.goaClient.get_accounts();

        accounts.forEach((object) => {
            if (!object.get_account())
                return;

            if (!object.get_files())
                return;

            let source = new Source({ object: object });

            let otherSources = newSources.get(source.name);
            if (!otherSources)
                otherSources = [];

            otherSources.push(source);
            newSources.set(source.name, otherSources);
            newItems[source.id] = source;
        });

        // Ensure an unique name for GOA accounts from the same provider
        newSources.forEach(function(sources, name) {
            if (sources.length == 1)
                return;

            sources.forEach(function(source) {
                let account = source.object.get_account();
                // Translators: the first %s is an online account provider name,
                // e.g. "Google". The second %s is the identity used to log in,
                // e.g. "foo@gmail.com".
                source.name = _("%s (%s)").format(account.provider_name,
                                                  account.presentation_identity);
            });
        });

        this.processNewItems(newItems);
    }

    getFilter(flags) {
        let item;

        if (flags & Query.QueryFlags.SEARCH)
            item = this.getActiveItem();
        else
            item = this.getItemById(SearchSourceStock.ALL);

        let filter;

        if (item.id == SearchSourceStock.ALL)
            filter = this.getAllFilter();
        else
            filter = item.getFilter();

        return filter;
    }

    getFilterNotLocal() {
        let sources = this.getItems();
        let filters = [];

        for (let idx in sources) {
            let source = sources[idx];
            if (!source.builtin)
                filters.push(source.getFilter());
        }

        if (filters.length == 0)
            filters.push('false');

        return '(' + filters.join(' || ') + ')';
    }

    hasOnlineSources() {
        let hasOnline = false;
        this.forEachItem(
            function(source) {
                if (source.object)
                    hasOnline = true;
            });

        return hasOnline;
    }

    hasProviderType(providerType) {
        let items = this.getForProviderType(providerType);
        return (items.length > 0);
    }

    getForProviderType(providerType) {
        let items = [];
        this.forEachItem((source) => {
            if (!source.object)
                return;

            let account = source.object.get_account();
            if (account.provider_type == providerType)
                items.push(source);
        });

        return items;
    }
}

var OFFSET_STEP = 50;

const OffsetController = class OffsetController {
    constructor() {
        this._offset = 0;
        this._itemCount = 0;
    }

    // to be called by the view
    increaseOffset() {
        this._offset += OFFSET_STEP;
        this.emit('offset-changed', this._offset);
    }

    // to be called by the model
    resetItemCount() {
        let query = this.getQuery();

        Application.connectionQueue.add(
            query.sparql, null, (object, res) => {
                let cursor = null;
                try {
                    cursor = object.query_finish(res);
                } catch (e) {
                    logError(e, 'Unable to execute count query');
                    return;
                }

                cursor.next_async(null, (object, res) => {
                    let valid = object.next_finish(res);

                    if (valid) {
                        this._itemCount = cursor.get_integer(0);
                        this.emit('item-count-changed', this._itemCount);
                    }

                    cursor.close();
                });
            });
    }

    getQuery() {
        log('Error: OffsetController implementations must override getQuery');
    }

    // to be called by the model
    resetOffset() {
        this._offset = 0;
    }

    getItemCount() {
        return this._itemCount;
    }

    getRemainingDocs() {
        return (this._itemCount - (this._offset + OFFSET_STEP));
    }

    getOffsetStep() {
        return OFFSET_STEP;
    }

    getOffset() {
        return this._offset;
    }
}
Signals.addSignalMethods(OffsetController.prototype);

var OffsetCollectionsController = class OffsetCollectionsController extends OffsetController {
    getQuery() {
        let activeCollection = Application.documentManager.getActiveCollection();
        let flags;

        if (activeCollection)
            flags = Query.QueryFlags.NONE;
        else
            flags = Query.QueryFlags.COLLECTIONS;

        return Application.queryBuilder.buildCountQuery(flags);
    }
}

var OffsetDocumentsController = class OffsetDocumentsController extends OffsetController {
    getQuery() {
        return Application.queryBuilder.buildCountQuery(Query.QueryFlags.DOCUMENTS);
    }
}

var OffsetSearchController = class OffsetSearchController extends OffsetController {
    getQuery() {
        return Application.queryBuilder.buildCountQuery(Query.QueryFlags.SEARCH);
    }
}
