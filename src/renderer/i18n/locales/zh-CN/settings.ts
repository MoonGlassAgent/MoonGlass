/** 设置页文案（外观 / 模型服务 Provider 配置 / 开发环境与 EDA 工具链探测） */

export const settings = {
  title: '设置',
  more: {
    title: '更多设置（占位）',
    description: '工具链路径配置（resources/moonglass/toolchains.json）· 公司编码规则管理 · 外观设置'
  },
  appearance: {
    title: '外观',
    description: '选择浅色、深色或跟随系统，并设置界面强调色。设置会自动保存。'
  },
  llm: {
    title: '模型服务',
    description: '配置大模型 Provider 的 API Key / Base URL / 模型列表（配置保存在本地，对话功能 Phase 2 接入）',
    addCustom: '添加自定义 Provider',
    customProviderName: '自定义 Provider',
    enableProvider: '启用该 Provider',
    protocol: '协议：{name}',
    protocolAnthropic: 'Anthropic Messages',
    protocolOpenai: 'OpenAI 兼容',
    name: '名称',
    showKey: '显示',
    hideKey: '隐藏',
    models: '模型列表',
    noModels: '暂无模型，请添加',
    modelPlaceholder: '输入模型 ID，回车添加',
    removeModel: '移除模型 {model}',
    add: '添加',
    noKey: '未配置 Key',
    testing: '测试中…',
    testConnection: '测试连接',
    providerConnection: 'Provider 连接',
    httpFoundModels: 'HTTP {status}，发现 {count} 个模型',
    httpProbedModels: 'HTTP {status}，已逐一探测 {count} 个配置模型',
    unknownError: '未知连接错误',
    thModelId: '模型 ID',
    thStatus: '状态',
    thNote: '说明',
    statusUntested: '未测试',
    noModelIds: '当前未配置模型 ID；Provider 连接结果仍然有效。',
    enabled: '已启用',
    disabled: '已停用',
    savedEnabled: '已保存并启用',
    savedDisabled: '已保存，但尚未启用',
    saveFailed: '保存失败：{message}',
    testException: '测试异常：{message}',
    testExceptionModel: '测试异常，模型未测试'
  },
  eda: {
    title: '开发环境与 EDA 工具链',
    description: '检查 MoonGlass 完整工作流所需的运行时、构建、验证、综合与时序工具。',
    detecting: '检测中…',
    redetect: '重新检测',
    detectingDetail: '正在逐项检查环境、版本与可执行文件路径…',
    ready: '{ready}/{total} 就绪',
    emptyGroup: '此分组没有收到检测项。请重启 MoonGlass，使主进程与界面版本保持一致。',
    noItems: '主进程未返回任何环境检测项，请重启 MoonGlass 后重试。',
    detectFailed: '环境检测失败：{message}',
    installStatusFailed: '安装状态读取失败：{message}',
    installStartFailed: '启动安装失败：{message}',
    confirmCocotb: '将使用当前 Python 的 pip 安装或升级 Cocotb、cocotb-bus 和 cocotb-coverage，是否继续？',
    confirmOssCad: '将从官方 GitHub Release 下载 OSS CAD Suite。文件较大，是否继续？',
    installingCocotb: '正在通过 pip 安装 Cocotb…',
    installingBundle: '正在下载并解压工具包，请保持网络连接…',
    installing: '安装中…',
    installCocotb: '安装 Cocotb',
    installBundle: '安装工具包',
    installGuide: '安装指南',
    openGuideTitle: '打开官方安装指南',
    builtinError: '内置组件异常',
    builtinErrorDetail: '该工具应随 MoonGlass 提供，请重新安装或更换完整软件包。',
    legacyDescription: '由旧版主进程返回的工具检测项',
    statusReady: '已就绪',
    statusNotFound: '未找到',
    importance: {
      required: '必要',
      recommended: '推荐',
      optional: '可选'
    },
    source: {
      bundled: 'MoonGlass 内置',
      managed: 'MoonGlass 管理安装',
      system: '系统环境'
    },
    categories: {
      runtime: { label: '基础运行环境', detail: 'Agent、技能脚本和依赖管理' },
      build: { label: '构建环境', detail: '版本管理与本地编译' },
      eda: { label: 'RTL 与综合', detail: 'Lint、仿真与逻辑综合' },
      verification: { label: '验证工具', detail: 'Cocotb、仿真器和波形查看' },
      physical: { label: '时序与物理实现', detail: 'STA 和物理感知优化' }
    }
  }
}

export type SettingsMessages = typeof settings
