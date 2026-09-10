import type { DesignBrowserMessages } from '../zh-CN/designBrowser'

export const designBrowser: DesignBrowserMessages = {
  backToWorkspace: '← Workspace',
  selectTopTitle: 'Multiple root modules detected; select the design top',
  elaborating: 'Elaborating…',
  reElaborate: 'Re-elaborate',
  autoElaborate: 'Auto Elaborate',
  useSelectedTop: 'Use Selected Top',
  navBack: 'Back',
  navBackAria: 'Navigate back',
  navForward: 'Forward',
  navForwardAria: 'Navigate forward',
  searchPlaceholder: 'Search instances / modules / nets…',
  noSearchResults: 'No matches',
  searchGroups: {
    instances: 'Instances',
    modules: 'Modules',
    nets: 'Nets'
  },
  dismissError: 'Dismiss error',
  autoLoading: 'Auto-loading {top}…',
  preparingDatabase: 'Preparing design database…',
  multipleRootsHint: 'Multiple possible root modules detected; select a Top to load',
  resizeHierarchy: 'Resize hierarchy panel width',
  resizeSignals: 'Resize signal list height',
  resizeInspector: 'Resize Inspector panel width',
  enterInstance: 'Enter Instance →',
  inspectorHint:
    'Click an identifier in the signal list or source to select a net; then expand the Driver / Load trace tree level by level',
  hierarchy: {
    expand: 'Expand',
    collapse: 'Collapse',
    expandNode: 'Expand {name}',
    collapseNode: 'Collapse {name}',
    openDefinitionHint: '{path} (double-click to open module definition)',
    expandAll: 'Expand All',
    expandAllAria: 'Expand all design hierarchy',
    collapseAll: 'Collapse All',
    collapseAllAria: 'Collapse all design hierarchy',
    filterPlaceholder: 'Filter instances / modules…',
    noMatchingInstances: 'No matching instances'
  },
  signals: {
    searchPlaceholder: 'Search nets',
    noMatchingSignals: 'No matching nets',
    noModuleSelected: 'No module selected'
  },
  source: {
    closeTab: 'Close {name}',
    emptyHint: 'Select an instance in the hierarchy tree on the left, or double-click an identifier in the source to jump'
  },
  trace: {
    expandTrace: 'Expand trace',
    collapseTrace: 'Collapse trace',
    noFurtherDriver: 'No further drivers',
    noFurtherLoad: 'No further loads'
  }
}
