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
    signals: '信号'
  },
  /** 搜索下拉 / 层次过滤列表截断提示 */
  searchTruncated: '仅显示前 {shown} 条 · 共 {total} 条',
  /** 头部数据库信息行 */
  databaseInfo: '{count} modules · {time}',
  /** RTL 输入已变更、缓存数据库过期提示徽标 */
  rtlStaleBadge: 'RTL 已变更，建议重新解析',
  /** Inspector 中 cell 详情标题（v2 Yosys 形态） */
  cellKind: 'Cell / Instance',
  /** cell pin 连接全部未命中 net 时的兜底展示 */
  cellDetail: {
    bitCount: '{count} bit'
  },
  /** Inspector 中实例详情（v3 slang 形态） */
  instance: {
    kind: 'Instance',
    module: '模块',
    parameters: '参数覆盖',
    noParameters: '（无参数覆盖）',
    connections: '连接',
    exprFallback: '（表达式）'
  },
  /** Inspector 中过程块详情（v3 slang 形态） */
  process: {
    kind: 'Process',
    clock: '时钟',
    reset: '复位',
    drives: '驱动',
    reads: '读取'
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
    title: 'HIERARCHY',
    diagnostics: 'Diagnostics',
    expand: '展开',
    collapse: '收起',
    expandNode: '展开 {name}',
    collapseNode: '收起 {name}',
    openDefinitionHint: '{path}（双击打开模块定义）',
    /** 实例节点 tooltip 中的参数覆盖列表 */
    parameterOverrides: '参数覆盖',
    expandAll: '全部展开',
    expandAllAria: '全部展开设计层次',
    collapseAll: '全部收起',
    collapseAllAria: '全部收起设计层次',
    filterPlaceholder: '过滤实例 / 模块…',
    noMatchingInstances: '无匹配实例'
  },
  signals: {
    title: 'SIGNALS',
    /** 计数行：模块显示名 · 过滤后/全部内部信号数 */
    count: '{module} · {shown}/{total} signals',
    ports: '端口',
    internalSignals: '内部信号',
    /** 信号 kind 徽标（wire/reg/logic 为类型标识符，不翻译） */
    kinds: {
      wire: 'wire',
      reg: 'reg',
      logic: 'logic',
      other: 'other'
    },
    searchPlaceholder: '搜索 signal',
    noMatchingSignals: '无匹配信号',
    noModuleSelected: '尚未选择模块'
  },
  source: {
    closeTab: '关闭 {name}',
    emptyHint: '在左侧层次树选择实例，或双击源码中的标识符进行跳转'
  },
  trace: {
    signal: 'Signal',
    drivers: 'DRIVERS',
    loads: 'LOADS / FANOUT',
    moreEndpoints: '+{count} 更多端点',
    expandTrace: '展开追踪',
    collapseTrace: '收起追踪',
    noFurtherDriver: '无进一步驱动',
    noFurtherLoad: '无进一步负载',
    /** 端点类型徽标（PORT/CELL/PIN/STMT 为标识符，不翻译，入 i18n 统一维护） */
    badges: {
      port: 'PORT',
      cell: 'CELL',
      pin: 'PIN',
      stmt: 'STMT'
    }
  }
}

export type DesignBrowserMessages = typeof designBrowser
