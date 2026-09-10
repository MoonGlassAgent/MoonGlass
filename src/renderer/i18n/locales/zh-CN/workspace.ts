/**
 * 阶段工作区页文案（WorkspacePage）
 *
 * 只覆盖界面可见文案：顶部操作区、托管/变更对话框、VERIF/SYNTH 操作条、
 * 文件查看器工具栏、底部工程控制台及 appendLog 输出到界面日志面板的消息。
 * 发给 Agent 的提示词、写入项目文件/托管报告的内容保持中文原文，不在此处。
 */

export const workspace = {
  notFound: '项目不存在或加载中…',
  backToProjects: '返回项目列表',
  currentPhase: '当前阶段：{phase} · {label}',
  startChange: '发起变更',
  generateDashboard: '生成总体报告',
  generatingDashboard: '正在生成…',
  verificationPosture: '验证态势',

  // 门禁检查结果区
  gate: {
    recheck: '🔄 重新检查门禁',
    fixThenRecheck: '修复问题后点击重新检查',
    forcedNotice: '⚠️ 已强制推进，遗留问题以红色感叹号标注',
    passed: '✅ 门禁通过，可推进'
  },

  // 一键托管对话框
  managedDialog: {
    title: '一键托管',
    description: '从当前阶段开始自动执行、修复门禁并推进。门禁重试失败时立即停止，不会强制越过。',
    endPhase: '托管完成至',
    hint: '自动决策会优先选择推荐项并记录到报告。涉及正式签核、第三方许可证或不可逆操作时，托管结果仍需工程师复核。',
    start: '开始托管',
    stop: '停止托管'
  },

  // 托管步骤条
  managedRun: {
    running: '托管进行中',
    lastRun: '最近托管',
    viewReport: '查看托管报告'
  },

  // 受控变更对话框
  changeDialog: {
    title: '发起受控变更',
    description: '保留已有成果，建立变更单，并从受影响的最早阶段开始处理。',
    typeLabel: '变更类型',
    typeRequirement: '需求变更',
    typeSpecification: '规格变更',
    typeBug: '第三方/测试缺陷',
    sourcePhase: '影响起点',
    descriptionLabel: '变更或缺陷说明',
    descriptionPlaceholder: '说明现象、期望行为、涉及接口、复现条件或新增规格...',
    submit: '创建并进入处理'
  },

  // 变更类型（日志文案用，与变更单文件内容的措辞保持一致）
  changeKind: {
    requirement: '需求变更',
    specification: '规格变更',
    bug: '缺陷修复'
  },

  // VERIF 阶段状态条
  verifBar: {
    statusLabel: 'VERIF 状态：',
    refresh: '刷新 VERIF 状态',
    current: '当前：{label}',
    next: '下一步：{action}',
    defaultNextAction: '生成 AIGV 验证规划',
    planEnv: '① 规划与环境',
    planEnvTitle: '验证点登记 + 环境搭建 + 冒烟验收（W0）',
    basic: '② 基础功能',
    basicTitle: '规格映射矩阵条款逐条闭环（W1）',
    corner: '③ 增补验证',
    cornerTitle: '按主题波执行 corner 场景（W2）',
    signoff: '④ 签核',
    signoffTitle: '覆盖率/Formal/Mutation/残余风险审批（W3）'
  },

  // SYNTH 阶段操作条
  synthBar: {
    label: '综合操作：',
    run: '⚙ 生成 SDC 并运行综合',
    agentRunning: 'Agent 运行中…'
  },

  // 主区与底部面板选项卡
  tabs: {
    chat: '💬 对话',
    problems: '问题',
    runs: '运行',
    verification: '验证',
    synthesis: '综合',
    artifacts: '产物'
  },

  // 底部工程控制台（跨选项卡共用）
  console: {
    title: '工程控制台',
    maximize: '最大化控制台',
    expand: '展开控制台',
    collapse: '收起控制台',
    trackableArtifacts: '{count} 个可追踪产物',
    errors: '{count} 错误',
    warnings: '{count} 警告',
    askAgentFix: '交给 Agent 修复',
    openProblemFile: '双击打开问题文件并定位',
    gateBadge: '门禁',
    doubleClickOpen: '双击打开'
  },

  // 问题选项卡
  problems: {
    empty: '当前没有已知问题。运行 Lint、验证或综合后，诊断信息会集中显示在这里。'
  },

  // 运行选项卡
  runs: {
    empty: '尚无运行记录。工具启动后，实时状态显示在这里，落盘日志也会自动汇总。'
  },

  // 验证选项卡（Verification Intelligence 视图）
  verification: {
    metricArtifacts: '验证产物',
    metricCriticalOpen: '关键未闭环',
    metricFormalEvidence: 'Formal 证据',
    metricIntents: '验证意图',
    metricSpecGaps: '规格缺口',
    viewsAria: '验证智能视图',
    viewScenario: '风险场景',
    viewIntent: '验证意图',
    viewHoles: '覆盖缺口',
    viewInteraction: '交互图',
    viewSchedule: '执行队列',
    viewFormal: 'Formal',
    analyzer: '分析器：{engine}',
    analyzerLegacy: '旧版模型',
    structuralSummary: 'FSM {fsm} · CFG {cfg} · 依赖 {deps} · COI {coi} · 协议 {protocols}',
    noIntelligence: '尚未生成 Verification Intelligence 模型。',
    buildIntelligence: '生成智能验证模型',
    scenarioBoardAria: 'Verification Intelligence Scenario 看板',
    openScenarioRegistry: '双击打开完整 Scenario Registry',
    interactionAria: 'Feature Interaction Graph',
    jumpToEvidence: '双击跳转到结构证据',
    noInteractions: '当前没有可展示的交互边。',
    intentAria: 'Verification Intent',
    openIntentRegistry: '双击打开完整 Verification Intent Registry',
    boundaryCount: '边界 {count}',
    noIntents: '尚未生成 Verification Intent。',
    holesAria: 'Coverage Hole 分类',
    noHoles: '当前没有待处理的 Coverage Hole。',
    scheduleAria: '验证执行队列',
    iterations: '{iterations} 次 · {budget}s',
    noScheduled: '关键 Scenario 已闭环，当前没有待调度任务。',
    formalAria: 'Formal 验证证据',
    openFormalResult: '双击打开 formal-result.json',
    traceCount: 'trace {count}',
    noFormal: '尚无 Formal 证据。Formal Candidate 可由主 Agent 使用 SymbiYosys 执行。',
    openingWaveform: '正在打开 {file}...',
    waveformOpened: '已用 GTKWave 打开 {file}',
    waveformFailed: '打开失败: {error}',
    openWaveformTitle: '使用 GTKWave 打开波形',
    openWaveform: '打开波形',
    empty: '暂无验证结果。运行仿真后，result.json、JUnit、覆盖率、日志和波形会出现在 verification/results/。'
  },

  // 综合选项卡
  synthesis: {
    metricArtifacts: '综合产物',
    metricConstraints: '约束文件',
    metricReports: '报告',
    empty: '尚未发现综合产物。运行综合后，这里会汇总 SDC、网表、面积和时序报告。'
  },

  // 产物选项卡
  artifacts: {
    empty: '暂无可追踪产物。工具输出的日志、报告、波形、网表和结果文件会汇总在这里。'
  },

  // 文件查看器工具栏
  viewer: {
    lineCount: '{count} 行 · 只读',
    findTitle: '查找（Ctrl+F）',
    findAria: '查找文件内容',
    source: '源码',
    preview: '预览',
    reload: '重新加载文件',
    wordWrapTitle: '切换自动换行',
    wordWrap: '自动换行',
    decreaseFont: '缩小字体',
    increaseFont: '放大字体',
    openExternal: '🌐 外部打开',
    truncated: '（内容过大，仅显示前 256 KB）',
    unreadable: '（无法读取该文件）'
  },

  // 底部状态栏
  statusBar: {
    toolchain: '工具链: {toolchain}',
    phases: '阶段处理: {done}/{total}',
    footer: 'MoonGlass v{version} · 六阶段 ASIC 开发链'
  },

  // window.confirm 确认框
  confirm: {
    gateBlocked: '门禁未完全通过（{count} 项 Error 级检查失败）。\n\n确定在门禁没有完全通过的情况下继续推进到 {phase} 吗？\n未通过的检查项将以红色感叹号保留为遗留问题。',
    rollback: '回退到 {phase} 后，后续阶段产出将被标记为废弃。确认回退？',
    enterDuringManaged: '一键托管进行中，托管流程依赖阶段推进顺序，手动切换阶段可能打乱编排。确认切换？',
    resetNoArtifacts: '  - 当前没有阶段产物',
    resetArchive: '归档并重新开始',
    resetPurge: '永久清除',
    resetPhase: '{action}“{phase}”？\n\n将处理 {count} 个文件（{size} MB）：\n{paths}\n\n{purgeNote}上游阶段成果会保留；已完成的后续阶段将标记黄色变更提醒。',
    resetPurgeNote: '该阶段会话历史也将清除；不会自动重新开始，需由你在会话中输入或使用一键托管。\n',
    resetPurgeConfirm: '这是不可恢复的彻底清除。确认永久删除上述阶段产物？',
    fastTrack: '将跳过验证检查和 QA 质量检查，直接进入综合实现。\n\n该路径仅用于快速评估面积，综合结果不能视为功能验证、质量签核或发布依据。确认继续？',
    completeProject: '确认综合实现已完成，并将项目标记为完成？'
  },

  // appendLog 输出到界面日志面板的消息
  log: {
    waveformOpened: '已用 GTKWave 打开：{path}',
    waveformOpenFailed: '波形打开失败：{error}',
    cannotOpenExternal: '⚠️ {path} 无法在外部打开',
    openedExternal: '🌐 已打开: {path}',
    fileOpenFailed: '文件打开失败：{path}：{error}',
    advanceFailed: '阶段推进失败: {error}',
    forceAdvanced: '⚠️ 用户确认在门禁未完全通过的情况下强制推进到 {phase}',
    rechecking: '🔄 重新运行门禁检查...',
    gateFailed: '❌ 门禁未通过',
    gateCheckDone: '✅ 门禁检查完成',
    gateCheckFailed: '❌ 门禁检查失败: {error}',
    enteredPhase: '已进入 {phase}，后续阶段产物已保留',
    enterPhaseFailed: '进入阶段失败: {error}',
    respondChangeStart: '开始响应 {phase} 的变更影响',
    respondChangeDone: '✅ {phase} 变更响应已完成',
    respondChangeFailed: '变更响应失败: {error}',
    gateIssuesSent: '已将 {count} 项门禁问题发送到 Agent 会话',
    gateFixSendFailed: '门禁修复指令发送失败: {error}',
    planEnvStart: '开始验证规划与环境搭建（W0）...',
    planEnvDone: '验证规划与环境搭建任务已完成',
    commandSendFailed: '指令发送失败: {error}',
    basicStart: '开始 W1 基础功能验证...',
    basicDone: '基础功能验证任务已完成',
    cornerStart: '开始 W2 增补验证（按主题波）...',
    cornerDone: '增补验证任务已完成',
    signoffStart: '开始 W3 签核...',
    signoffDone: '签核任务已完成',
    phaseResetFailed: '阶段处理失败: {error}',
    archived: '已归档 {phase} 的 {count} 个文件到 {path}，并以空白会话重新开始',
    purged: '已彻底清除 {phase} 的 {count} 个文件及阶段会话；未自动重新开始',
    dashboardGenerated: '总体报告已生成: {path}',
    dashboardNotOpened: '总体报告未能自动打开，请从文件树打开 docs/07_release/project_dashboard.html',
    dashboardFailed: '总体报告生成失败: {error}',
    guidanceActionSent: '已按验证态势推荐动作交给主 Agent…',
    guidanceActionDone: '验证推荐动作已完成，请刷新 VERIF 状态或验证态势',
    guidanceActionFailed: '验证推荐动作失败：{error}',
    managedRetry: '一键托管：Agent 执行异常，第 {attempt}/3 次重试：{error}',
    managedDecisionSendFailed: '一键托管：自动决策回传失败，第 {attempt}/3 次重试：{error}',
    managedTaskSessionFailed: '一键托管：开启任务会话失败，沿用当前会话：{error}',
    managedChangeFailed: '一键托管：{phase} 变更响应异常，记录风险并继续：{error}',
    managedVerifBatches: '一键托管：VERIF 批次编排完成 {count} 批（{stoppedBy}）：{message}',
    managedAgentFailed: '一键托管：{phase} Agent 异常，记录风险并继续检查门禁：{error}',
    managedGateCarried: '一键托管：{phase} 门禁仍有 {count} 个阻断项，已标记未签核并继续推进',
    managedGateRecoveryFailed: '一键托管：门禁恢复 Agent 异常，继续下一轮：{error}',
    managedFinished: '{result}，报告：{path}',
    managedCompleted: '一键托管完整通过',
    managedCompletedWithRisk: '一键托管带 {count} 项风险完成（未签核）',
    managedPaused: '一键托管已暂停',
    changeCreated: '已创建{kind} {id}，进入 {phase}',
    synthesisStart: '⚙ 开始逻辑综合流程...',
    synthesisDone: '综合评估任务已完成',
    synthesisSendFailed: '❌ 综合指令发送失败: {error}'
  }
}

export type WorkspaceMessages = typeof workspace
