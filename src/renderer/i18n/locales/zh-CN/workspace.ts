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

  // 阶段产物漂移对账对话框（记录显示已完成但产物目录已不存在）
  artifactDrift: {
    title: '检测到阶段产物与记录不一致',
    description: '数据库记录显示以下阶段已完成，但对应产物目录已不在磁盘上。请选择处理方式。',
    entryHint: '记录显示已完成，但产物目录已不存在：{paths}',
    resetDownstream: '同时重置下游已完成阶段的记录（QA/SYNTH 的结论建立在已删除的证据上）',
    keepHint: '保持现状后，可以随时通过阶段看板悬停的"清除重置"手动处理；若打算自行恢复产物，Agent 继续原会话即可。',
    startOver: '从 0 开始',
    purging: '正在清除…',
    keep: '保持现状',
    progress: '正在清除漂移阶段记录（{index}/{total}）…'
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
    signoffTitle: '覆盖率/Formal/Mutation/残余风险审批（W3）',
    expertActions: '专家操作',
    expertActionsHint: '手动分波段推进验证（面向熟悉波段方法学的用户）；一般走主行动即可'
  },

  // SYNTH 阶段操作条
  synthBar: {
    label: '综合操作：',
    run: '⚙ 生成 SDC 并运行综合',
    agentRunning: 'Agent 运行中…'
  },

  // 主区选项卡
  tabs: {
    chat: '💬 对话',
    verifRun: '🔬 验证运行'
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
    manualTakeover: '自动验证循环正在运行。\n\n将暂停自动循环，改为你手动执行该动作？',
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
    driftPurging: '检测到产物漂移：正在清除 {phase} 的记录（{index}/{total}）…',
    driftPurged: '已从 0 开始：清除 {count} 个漂移阶段的记录及对应会话',
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
    managedRunLoopStarted: '一键托管：验证运行循环已启动（默认预算），等待循环跑到终态或暂停…',
    managedRunLoopCompleted: '一键托管：验证运行循环已完成（{beats} 步），继续托管推进门禁/QA',
    managedRunLoopHalted: '一键托管：验证运行循环停在「{state}」（{reason}），托管停止；请前往"验证运行"页签处置，恢复循环后可手动推进',
    managedRunLoopStopFailed: '停止验证运行循环失败：{error}',
    runLoopStarted: '验证运行循环已启动',
    runLoopPauseFailed: '暂停验证运行循环失败：{error}（仍继续手动执行）',
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
