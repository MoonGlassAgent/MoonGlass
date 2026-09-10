/** IP 模板库页文案 */

export const ipLibrary = {
  title: 'IP 模板库',
  description: '选择一个目录后自动递归发现多个 IP、RTL 与验证组件，供 Agent、RTL 生成和验证流程复用。',
  apiNotReady: 'IP 库后台 API 尚未加载。请完全退出并重新启动 MoonGlass，使 main/preload 进程加载最新代码。',
  readyBadge: '就绪 {ready}/{total}',
  localBadge: '用户库 {count}',
  ipBadge: 'IP {count}',
  form: {
    nameLabel: 'IP 库名称',
    namePlaceholder: '例如 公司通用 IP',
    typeLabel: '类型',
    pathLabel: '目录路径',
    chooseDirectory: '选择目录',
    importSubmit: '导入',
    importing: '导入中'
  },
  footnote: 'MoonGlass 会自动跳过构建目录，按 metadata、源码目录和 HDL 文件识别 IP 边界，并提取协议、接口角色与组件用途；不会执行库内脚本，也不会修改源文件。',
  errorNoPath: '请先选择或输入 IP 库目录',
  importedTip: '已导入 {name}，索引到 {count} 个 IP',
  piAnalyzedTip: 'Pi 已完成 {name} 的语义分析，共更新 {count} 个 IP',
  registered: {
    title: '已登记 IP 库',
    empty: '尚未登记 IP 库'
  },
  sourceBuiltin: '内置',
  sourceUser: '用户',
  sourceLocal: '本地',
  subtitle: '{source} · {type} · {ipCount} 个 IP · {fileCount} 个文件',
  status: {
    ready: '索引就绪',
    missing: '目录不存在',
    indexing: '索引中',
    error: '索引失败'
  },
  kind: {
    rtl: 'RTL',
    verification: '验证',
    document: '文档',
    constraint: '约束',
    script: '脚本',
    metadata: '元数据',
    other: '其他'
  },
  component: {
    rtlIp: 'RTL IP',
    verificationComponent: '验证组件',
    mixed: 'RTL + 验证',
    reference: '参考资源'
  },
  semantic: {
    label: 'Pi 语义分析：{status}',
    completed: '已完成 · {model}',
    running: '分析中',
    failed: '失败'
  },
  actions: {
    openFolder: '打开目录',
    reindex: '重新建立索引',
    enhance: '使用 Pi 补充功能、协议与许可证语义',
    enhancing: 'Pi 语义分析正在运行',
    remove: '移除登记（不会删除目录）'
  },
  templates: {
    title: '模板分类',
    searchPlaceholder: '搜索 IP、topModule 或路径',
    count: '{count} 个 IP',
    empty: '暂无 IP'
  },
  confidence: '识别 {percent}%',
  piEnhanced: 'Pi 增强',
  presets: {
    busInterface: '总线接口',
    storage: '存储相关',
    clock: '时钟相关',
    arbiter: '仲裁器',
    utility: '工具模块',
    userImported: '用户导入'
  }
}

export type IpLibraryMessages = typeof ipLibrary
