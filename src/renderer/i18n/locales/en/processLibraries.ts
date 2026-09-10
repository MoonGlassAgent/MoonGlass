import type { ProcessLibrariesMessages } from '../zh-CN/processLibraries'

export const processLibraries: ProcessLibrariesMessages = {
  title: 'Process Libraries',
  description: 'Manage local PDKs, standard-cell libraries, and macro views used by synthesis and physical implementation.',
  addLocal: 'Add Local Directory',
  registered: {
    title: 'Registered Process Libraries',
    hint: 'The Agent reads the unified index automatically',
    empty: 'No process libraries registered yet'
  },
  status: {
    ready: 'Index ready',
    missing: 'Directory missing',
    indexing: 'Indexing',
    error: 'Index failed'
  },
  kind: {
    liberty: 'Liberty',
    lef: 'LEF',
    gds: 'GDS',
    verilog: 'Verilog',
    spice: 'SPICE/CDL',
    tech: 'Tech',
    mapping: 'Map',
    other: 'Other'
  },
  maturity: {
    reference: 'Reference Platform',
    experimental: 'Experimental',
    research: 'Research Use'
  },
  fileCount: '{count} files total',
  actions: {
    openFolder: 'Open folder',
    reindex: 'Rebuild index',
    remove: 'Unregister (directory is not deleted)'
  },
  openSource: {
    title: 'Open-Source Process Libraries',
    note: 'Downloads come from public projects; experimental and research libraries must not be treated as production sign-off references.',
    download: 'Download',
    downloading: 'Downloading & Indexing',
    installed: 'Installed',
    repository: 'Repository'
  }
}
