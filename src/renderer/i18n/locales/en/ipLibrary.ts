import type { IpLibraryMessages } from '../zh-CN/ipLibrary'

export const ipLibrary: IpLibraryMessages = {
  title: 'IP Template Library',
  description: 'Select a directory to recursively discover IPs, RTL, and verification components for reuse by the Agent, RTL generation, and verification flows.',
  apiNotReady: 'The IP library backend API is not loaded yet. Quit and restart MoonGlass completely so the main/preload processes pick up the latest code.',
  readyBadge: 'Ready {ready}/{total}',
  localBadge: 'User libraries {count}',
  ipBadge: 'IPs {count}',
  form: {
    nameLabel: 'Library Name',
    namePlaceholder: 'e.g. Company Common IPs',
    typeLabel: 'Type',
    pathLabel: 'Directory Path',
    chooseDirectory: 'Choose directory',
    importSubmit: 'Import',
    importing: 'Importing'
  },
  footnote: 'MoonGlass automatically skips build directories, identifies IP boundaries from metadata, source directories, and HDL files, and extracts protocols, interface roles, and component purposes. It never executes scripts inside the library or modifies source files.',
  errorNoPath: 'Select or enter an IP library directory first',
  importedTip: 'Imported {name}; indexed {count} IPs',
  piAnalyzedTip: 'Pi finished semantic analysis of {name}; updated {count} IPs',
  registered: {
    title: 'Registered IP Libraries',
    empty: 'No IP libraries registered yet'
  },
  sourceBuiltin: 'Built-in',
  sourceUser: 'User',
  sourceLocal: 'Local',
  subtitle: '{source} · {type} · {ipCount} IPs · {fileCount} files',
  status: {
    ready: 'Index ready',
    missing: 'Directory missing',
    indexing: 'Indexing',
    error: 'Index failed'
  },
  kind: {
    rtl: 'RTL',
    verification: 'Verification',
    document: 'Docs',
    constraint: 'Constraints',
    script: 'Scripts',
    metadata: 'Metadata',
    other: 'Other'
  },
  component: {
    rtlIp: 'RTL IP',
    verificationComponent: 'Verification Component',
    mixed: 'RTL + Verification',
    reference: 'Reference'
  },
  semantic: {
    label: 'Pi semantic analysis: {status}',
    completed: 'Completed · {model}',
    running: 'Analyzing',
    failed: 'Failed'
  },
  actions: {
    openFolder: 'Open folder',
    reindex: 'Rebuild index',
    enhance: 'Enrich functionality, protocol, and license semantics with Pi',
    enhancing: 'Pi semantic analysis is running',
    remove: 'Unregister (directory is not deleted)'
  },
  templates: {
    title: 'Template Categories',
    searchPlaceholder: 'Search IPs, top modules, or paths',
    count: '{count} IPs',
    empty: 'No IPs yet'
  },
  confidence: 'Confidence {percent}%',
  piEnhanced: 'Pi enhanced',
  presets: {
    busInterface: 'Bus Interface',
    storage: 'Storage',
    clock: 'Clock',
    arbiter: 'Arbiter',
    utility: 'Utility',
    userImported: 'User Imported'
  }
}
