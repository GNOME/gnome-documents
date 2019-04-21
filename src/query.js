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
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Search = imports.search;

var QueryColumns = {
    URN: 0,
    URI: 1,
    FILENAME: 2,
    MIMETYPE: 3,
    TITLE: 4,
    AUTHOR: 5,
    MTIME: 6,
    IDENTIFIER: 7,
    RDFTYPE: 8,
    RESOURCE_URN: 9,
    SHARED: 10,
    DATE_CREATED: 11
};

var QueryFlags = {
    NONE: 0,
    UNFILTERED: 1 << 0,
    COLLECTIONS: 1 << 1,
    DOCUMENTS: 1 << 2,
    SEARCH: 1 << 3
};

var LOCAL_DOCUMENTS_COLLECTIONS_IDENTIFIER = 'gd:collection:local:';

var QueryBuilder = GObject.registerClass(
    class QueryBuilder extends GObject.Object {

    _init(context) {
        this._context = context;
    }

    _createQuery(sparql) {
        return { sparql: sparql,
                 activeSource: this._context.sourceManager.getActiveItem() };
    }

    _buildFilterString(currentType, flags, isFtsEnabled) {
        let filters = [];

        if (!isFtsEnabled)
            filters.push(this._context.searchMatchManager.getFilter(flags));
        filters.push(this._context.sourceManager.getFilter(flags));

        if (currentType) {
            filters.push(currentType.getFilter());
        }

        return 'FILTER (' + filters.join(' && ') + ')';
    }

    _buildOptional() {
        let sparql =
            'OPTIONAL { ?urn nco:creator ?creator . } ' +
            'OPTIONAL { ?urn nco:publisher ?publisher . } ';

        return sparql;
    }

    _addWhereClauses(partsList, global, flags, searchTypes, ftsQuery) {
        // build an array of WHERE clauses; each clause maps to one
        // type of resource we're looking for.
        searchTypes.forEach(Lang.bind(this,
            function(currentType) {
                let part = '{ ' + currentType.getWhere() + ftsQuery;
                part += this._buildOptional();

                if ((flags & QueryFlags.UNFILTERED) == 0) {
                    if (global)
                        part += this._context.documentManager.getWhere();

                    part += this._buildFilterString(currentType, flags, ftsQuery.length > 0);
                }

                part += ' }';
                partsList.push(part);
            }));
    }

    _buildWhere(global, flags) {
        let whereSparql = 'WHERE { ';
        let whereParts = [];
        let searchTypes = [];

        if (flags & QueryFlags.COLLECTIONS)
            searchTypes = [this._context.searchTypeManager.getItemById(Search.SearchTypeStock.COLLECTIONS)];
        else if (flags & QueryFlags.DOCUMENTS)
            searchTypes = this._context.searchTypeManager.getDocumentTypes();
        else if (flags & QueryFlags.SEARCH)
            searchTypes = this._context.searchTypeManager.getCurrentTypes();
        else
            searchTypes = this._context.searchTypeManager.getAllTypes();

        let matchItem = this._context.searchMatchManager.getActiveItem();

        // Skip matchTypes when only doing fts
        if (matchItem.id != Search.SearchMatchStock.CONTENT) {
            this._addWhereClauses(whereParts, global, flags, searchTypes, '');
        }

        if (flags & QueryFlags.SEARCH) {
            let ftsWhere = this._context.searchMatchManager.getWhere();

            // Need to repeat the searchTypes part to also include fts
            // Note that the filter string needs to be slightly different for the
            // fts to work properly
            if (ftsWhere.length || matchItem.id == Search.SearchMatchStock.CONTENT) {
                this._addWhereClauses(whereParts, global, flags, searchTypes, ftsWhere);
            }
        }

        // put all the clauses in an UNION
        whereSparql += whereParts.join(' UNION ');
        whereSparql += ' }';

        return whereSparql;
    }

    _buildQueryInternal(global, flags, offsetController, sortBy) {
        let whereSparql = this._buildWhere(global, flags);
        let tailSparql = '';

        // order results depending on sortBy
        if (global) {
            let offset = 0;
            let step = Search.OFFSET_STEP;

            tailSparql += 'ORDER BY DESC(fts:rank(?urn)) ';

            if (offsetController) {
                offset = offsetController.getOffset();
                step = offsetController.getOffsetStep();
            }

            switch (sortBy) {
            case Gd.MainColumns.PRIMARY_TEXT:
                tailSparql += 'ASC(?title) ASC(?filename)';
                break;
            case Gd.MainColumns.SECONDARY_TEXT:
                tailSparql += 'ASC(?author)';
                break;
            case Gd.MainColumns.MTIME:
                tailSparql += 'DESC(?mtime)';
                break;
            default:
                tailSparql += 'DESC(?mtime)';
                break;
            }

            tailSparql += ('LIMIT %d OFFSET %d').format(step, offset);
        }

        let sparql =
            'SELECT DISTINCT ?urn ' + // urn
            'nie:url(?urn) ' + // uri
            'nfo:fileName(?urn) AS ?filename ' + // filename
            'nie:mimeType(?urn)' + // mimetype
            'nie:title(?urn) AS ?title ' + // title
            'tracker:coalesce(nco:fullname(?creator), nco:fullname(?publisher), \'\') AS ?author ' + // author
            'tracker:coalesce(nfo:fileLastModified(?urn), nie:contentLastModified(?urn)) AS ?mtime ' + // mtime
            'nao:identifier(?urn) ' + // identifier
            'rdf:type(?urn) ' + // type
            'nie:dataSource(?urn) ' + // resource URN
            '( EXISTS { ?urn nco:contributor ?contributor FILTER ( ?contributor != ?creator ) } ) ' + // shared
            'tracker:coalesce(nfo:fileCreated(?urn), nie:contentCreated(?urn)) ' + // date created
            whereSparql + tailSparql;

        return sparql;
    }

    buildSingleQuery(flags, resource) {
        let sparql = this._buildQueryInternal(false, flags, null);
        sparql = sparql.replace(/\?urn/g, '<' + resource + '>');

        return this._createQuery(sparql);
    }

    buildGlobalQuery(flags, offsetController, sortBy) {
        return this._createQuery(this._buildQueryInternal(true, flags, offsetController, sortBy));
    }

    buildCountQuery(flags) {
        let sparql = 'SELECT DISTINCT COUNT(?urn) ' +
            this._buildWhere(true, flags);

        return this._createQuery(sparql);
    }

    // queries for all the items which are part of the given collection
    buildCollectionIconQuery(resource) {
        let sparql =
            ('SELECT ' +
             '?urn ' +
             'tracker:coalesce(nfo:fileLastModified(?urn), nie:contentLastModified(?urn)) AS ?mtime ' +
             'WHERE { ?urn nie:isPartOf ?collUrn } ' +
             'ORDER BY DESC (?mtime)' +
             'LIMIT 4').replace(/\?collUrn/, '<' + resource + '>');

        return this._createQuery(sparql);
    }

    // queries for all the collections the given item is part of
    buildFetchCollectionsQuery(resource) {
        let sparql =
            ('SELECT ' +
             '?urn ' +
             'WHERE { ?urn a nfo:DataContainer . ?docUrn nie:isPartOf ?urn }'
            ).replace(/\?docUrn/, '<' + resource + '>');

        return this._createQuery(sparql);
    }

    // adds or removes the given item to the given collection
    buildSetCollectionQuery(itemUrn, collectionUrn, setting) {
        let sparql = ('%s { <%s> nie:isPartOf <%s> }'
                     ).format((setting ? 'INSERT' : 'DELETE'), itemUrn, collectionUrn);
        return this._createQuery(sparql);
    }

    // bumps the mtime to current time for the given resource
    buildUpdateMtimeQuery(resource) {
        let time = GdPrivate.iso8601_from_timestamp(GLib.get_real_time() / GLib.USEC_PER_SEC);
        let sparql = ('INSERT OR REPLACE { <%s> nie:contentLastModified \"%s\" }'
                     ).format(resource, time);

        return this._createQuery(sparql);
    }

    buildCreateCollectionQuery(name) {
        let time = GdPrivate.iso8601_from_timestamp(GLib.get_real_time() / GLib.USEC_PER_SEC);
        let sparql = ('INSERT { _:res a nfo:DataContainer ; a nie:DataObject ; ' +
                      'nie:contentLastModified \"' + time + '\" ; ' +
                      'nie:title \"' + name + '\" ; ' +
                      'nao:identifier \"' + LOCAL_DOCUMENTS_COLLECTIONS_IDENTIFIER + name + '\" }');

        return this._createQuery(sparql);
    }

    buildDeleteResourceQuery(resource) {
        let sparql = ('DELETE { <%s> a rdfs:Resource }').format(resource);

        return this._createQuery(sparql);
    }
});
