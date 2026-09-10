/** RTL 设计浏览器页面（DesignBrowserPage）及层次 / 源码 / 信号 / 追踪面板文案 */

export const designBrowser = {
  backToWorkspace: '← 工作区',
  selectTopTitle: '检测到多个根模块，请选择设计顶层',
  elaborating: 'Elaborating…',
  reElaborate: '重新解析',
  autoElaborate: '自动解析',
  useSelectedTop: '使用所选 Top',
  navBack: '后退',
  navBackAria: '导航后退',
  navForward: '前进',
  navForwardAria: '导航前进',
  searchPlaceholder: '全局搜索实例 / 模块 / 信号…',
  noSearchResults: '无匹配结果',
  searchGroups: {
    instances: '实例',
    modules: '模块',
    nets: '信号'
  },
  dismissError: '关闭错误提示',
  autoLoading: '正在自动加载 {top}…',
  preparingDatabase: '正在准备设计数据库…',
  multipleRootsHint: '检测到多个可能的根模块，请选择 Top 后加载',
  resizeHierarchy: '调整设计层次区域宽度',
  resizeSignals: '调整信号列表区域高度',
  resizeInspector: '调整 Inspector 区域宽度',
  enterInstance: '进入该实例 →',
  inspectorHint: '在信号列表或源码中单击标识符选择信号；选中后可逐层展开 Driver / Load 追踪树',
  hierarchy: {
    expand: '展开',
    collapse: '收起',
    expandNode: '展开 {name}',
    collapseNode: '收起 {name}',
    openDefinitionHint: '{path}（双击打开模块定义）',
    expandAll: '全部展开',
    expandAllAria: '全部展开设计层次',
    collapseAll: '全部收起',
    collapseAllAria: '全部收起设计层次',
    filterPlaceholder: '过滤实例 / 模块…',
    noMatchingInstances: '无匹配实例'
  },
  signals: {
    searchPlaceholder: '搜索 net',
    noMatchingSignals: '无匹配信号',
    noModuleSelected: '尚未选择模块'
  },
  source: {
    closeTab: '关闭 {name}',
    emptyHint: '在左侧层次树选择实例，或双击源码中的标识符进行跳转'
  },
  trace: {
    expandTrace: '展开追踪',
    collapseTrace: '收起追踪',
    noFurtherDriver: '无进一步驱动',
    noFurtherLoad: '无进一步负载'
  }
}

export type DesignBrowserMessages = typeof designBrowser
