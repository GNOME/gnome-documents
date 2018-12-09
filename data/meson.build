subdir('icons')

# FIXME: this is a workaround for libgd source location
libgd_src_path = join_paths(meson.source_root(), 'subprojects', 'libgd', 'libgd')

enum_headers = files(
  join_paths(libgd_src_path, 'gd-main-view.h'),
  join_paths(libgd_src_path, 'gd-main-view-generic.h')
)

gnome.mkenums(
  'org.gnome.Documents.enums.xml',
  sources: enum_headers,
  comments: '<!-- @comment@ -->',
  fhead: '<schemalist>',
  vhead: '  <@type@ id="org.gnome.Documents.@EnumName@">',
  vprod: '    <value nick="@valuenick@" value="@valuenum@"/>',
  vtail: '  </@type@>',
  ftail: '</schemalist>',
  install_header: true,
  install_dir: documents_schemadir
)

resource_data = files(
  'application.css',
  'media/dnd-counter.svg',
  'media/thumbnail-frame.png',
  'ui/documents-app-menu.ui',
  'ui/books-app-menu.ui',
  'ui/help-overlay.ui',
  'ui/help-overlay.ui',
  'ui/organize-collection-dialog.ui',
  'ui/preview-context-menu.ui',
  'ui/preview-menu.ui',
  'ui/selection-menu.ui',
  'ui/selection-toolbar.ui',
  'ui/view-menu.ui'
)

desktop_file_validate = find_program('desktop-file-validate')

schemas = []

foreach app: documents_apps
  resource = app + '.data'

  sources += gnome.compile_resources(
    resource,
    resource + '.gresource.xml',
    source_dir: '.',
    dependencies: resource_data,
    gresource_bundle: true,
    install: true,
    install_dir: documents_pkgdatadir
  )

  appdata = app + '.appdata.xml'

  i18n.merge_file(
    appdata,
    input: appdata + '.in',
    output: appdata,
    po_dir: po_dir,
    install: true,
    install_dir: join_paths(documents_datadir, 'metainfo')
  )

  desktop = app + '.desktop'

  desktop_file = i18n.merge_file(
    desktop,
    type: 'desktop',
    input: desktop + '.in',
    output: desktop,
    po_dir: po_dir,
    install: true,
    install_dir: join_paths(documents_datadir, 'applications')
  )

  schemas += app.to_lower() + '.gschema.xml'
endforeach

install_data(
  schemas,
  install_dir: documents_schemadir
)

install_data(
  'org.gnome.Documents.search-provider.ini',
  install_dir: join_paths(documents_datadir, 'gnome-shell', 'search-providers')
)
