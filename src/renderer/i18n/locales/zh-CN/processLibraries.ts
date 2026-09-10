/** 工艺库页文案 */

export const processLibraries = {
  title: '工艺库',
  description: '管理综合与物理实现使用的本地 PDK、标准单元库和宏视图。',
  addLocal: '添加本地目录',
  registered: {
    title: '已登记工艺库',
    hint: 'Agent 自动读取统一索引',
    empty: '尚未登记工艺库'
  },
  status: {
    ready: '索引就绪',
    missing: '目录不存在',
    indexing: '索引中',
    error: '索引失败'
  },
  kind: {
    liberty: 'Liberty',
    lef: 'LEF',
    gds: 'GDS',
    verilog: 'Verilog',
    spice: 'SPICE/CDL',
    tech: 'Tech',
    mapping: 'Map',
    other: '其他'
  },
  maturity: {
    reference: '参考平台',
    experimental: '实验版本',
    research: '研究用途'
  },
  fileCount: '共 {count} 个文件',
  actions: {
    openFolder: '打开目录',
    reindex: '重新建立索引',
    remove: '移除登记（不会删除目录）'
  },
  openSource: {
    title: '开源工艺库',
    note: '下载内容来自公开项目；实验与研究库不可直接视为量产签核依据。',
    download: '下载',
    downloading: '下载并索引中',
    installed: '已安装',
    repository: '官方仓库'
  }
}

export type ProcessLibrariesMessages = typeof processLibraries
