/**
 * 验证运行中心（VerifRunPanel / 根因链 / 诊断时间线）文案。
 * 批次进度、修复卡片、修复窗口横幅、根因链视图、诊断账本时间线。
 *
 * 术语：循环「步」= 循环完成一次「读态势 → 推导动作 → 派发执行 → 判定结果」的完整回合
 * （内部与账本字段仍称 beat；界面统一称"步"，不再使用自造的"拍"）。
 * 注意一「步」不等于一件事：批次类动作的一步内部可含多批（默认最多 20 批）。
 */
export const verifRun = {
  tabTitle: '验证运行',
  batch: {
    title: '批次编排',
    empty: '尚未启动批次编排',
    startBasic: '开始基础验证',
    state: {
      idle: '空闲',
      running: '运行中',
      'awaiting-rtl-fix': '等待 RTL 修复',
      'circuit-broken': '已熔断',
      completed: '已完成',
      stopped: '已停止'
    },
    currentBatch: '第 {index} 批',
    phaseDispatched: '已派发',
    phaseSettling: '判定中',
    dispatchedAt: '派发于 {time}',
    waitingFix: '等待修复 {rootCauseId}（自 {time}）',
    breakerTitle: '熔断原因',
    continueInChat: '在对话中继续',
    historyTitle: '本次循环已完成批次',
    verdictCompleted: '正常完成',
    verdictCircuitBroken: '熔断',
    /** 场景标题快照缺失（旧账本）：只显示场景 ID，不用当前注册表回填历史语义 */
    legacyNoLabels: '该批次记录早于「场景标题快照」，只能显示场景 ID；跑一次新批次即可看到验证内容',
    /** 快照里有该场景但标题为空（派发时注册表不可读或 ID 未命中） */
    scenarioUntitled: '（无标题快照）',
    updatedAt: '更新于 {time}'
  },
  loop: {
    title: '自动验证循环',
    empty: '尚未启动自动验证循环',
    wave: '当前波段 {wave}',
    waveNone: '当前波段 —',
    beat: '第 {n} 步',
    currentTitle: '当前动作',
    noCurrent: '本步尚未派发动作',
    sessionLabel: '会话 {name}',
    state: {
      idle: '空闲',
      planning: '规划中',
      running: '运行中',
      judging: '判定中',
      repairing: '修复中',
      'paused-human': '待人工',
      'paused-breaker': '已熔断',
      'signoff-review': '签核审查',
      'gate-check': '门禁检查',
      completed: '已完成',
      stopped: '已停止'
    },
    source: {
      rule: '规则',
      llm: 'LLM',
      human: '人工'
    },
    beatsBudget: '循环步数',
    tokensBudget: 'Token',
    wallBudget: '墙钟',
    minutesSuffix: ' 分钟',
    pauseHumanTitle: '待人工处置',
    pauseBreakerTitle: '已熔断',
    pauseSince: '自 {time}',
    pendingTitle: '待办项',
    beatsTitle: '最近步骤（新在前，绿点=推进）',
    decisionsTitle: '决策请示',
    proposedEmpty: '暂无待裁决的决策提案',
    /** 会话底部循环请示区的副标题提示 */
    proposedHint: '（验证循环暂停待人：批准后自动续跑，否决转熔断处置）',
    rationaleLabel: '理由',
    humanSummary: '工程师摘要',
    techDetails: '技术细节',
    promptLabel: '动作指令',
    expectedLabel: '预期产出',
    stopCriteriaLabel: '停止条件',
    evidenceCount: '证据 {count} 条',
    approve: '批准',
    reject: '否决',
    deciding: '提交中…',
    historyTitle: '决策历史（{count}）',
    outcome: {
      advanced: '推进',
      'no-progress': '无进展',
      failed: '失败',
      none: '未回填'
    },
    start: '启动自动验证',
    /** 终态（已停止/已完成）的再启动入口：开新循环，预填上轮预算 */
    restart: '重新启动循环',
    pause: '暂停',
    resume: '继续',
    stop: '停止',
    actionFailed: '操作失败：{error}',
    /** 启动报"已在运行"（残留句柄）时的逃生门：先停止再重启 */
    forceRestart: '强制停止并重启',
    startDialog: {
      title: '启动自动验证循环',
      description: '循环逐步自动推导并执行验证动作（规划/批次/修复/签核/门禁），需要人工时结构化暂停、答完自动续跑。预算是无人值守的硬护栏，超限即熔断。',
      maxBeats: '循环步数上限',
      maxBeatsHint: '最多自动执行多少步；每步 = 一次验证动作派发（批次类动作的一步内部可含多批），默认 50',
      maxTokens: 'Token 上限',
      maxTokensHint: '本次循环累计 token 上限（默认 5,000,000）',
      maxWallMinutes: '墙钟上限（分钟）',
      maxWallMinutesHint: '循环最长运行时间（默认 240 分钟）',
      noProgressLimit: '连续无进展上限（步）',
      noProgressLimitHint: '连续多少步无进展即熔断升级（默认 3）',
      confirm: '启动'
    },
    resumeDialog: {
      title: '继续自动验证循环',
      description: '可在此调大预算上限后继续。手动继续即人工值守：循环步数/token/墙钟三维计数归零，从继续时刻重新开窗（无人值守时长重新计）。',
      confirm: '继续'
    },
    /** 继续对话框顶部琥珀提示行：当前消耗（墙钟为本窗口已运行时长） */
    consumption: '当前消耗：已 {beats} 步 · token {tokens} · 本窗口已运行 {minutes} 分钟',
    /** 墙钟预设 chip 标签（值用分钟）：{n} 小时 */
    presetHours: '{n} 小时',
    /** 战略层摘要（一个数 + 一句话）：闭环率、机器生成的一句话与预算琥珀警示 */
    summary: {
      /** 卡壳（blocked）：待人工处置一句话优先展示 */
      blocked: '{wave} · {summary}',
      /** 起步中：无 forecast 或速率数据 */
      warmup: '{wave} · 起步中，尚无速率数据',
      /** 预警（binding=insufficient）：预算只能走到约 {projected} 条 */
      insufficient: '{wave} · 按当前打法 {covered}/{total}，预算只能走到约 {projected} 条——建议处理（调预算或改策略）',
      /** 策略态：已切换「{strategy}」{reason}（reason 含前导冒号） */
      strategy: '{wave} · 已切换「{strategy}」{reason}',
      /** 正常：进度 + ETA 区间 + 预算 binding 文案 */
      normalWithEta: '{wave} · {progress}，按当前速率还需约 {low}–{high} 小时，预算{binding}',
      /** 正常：预测无 ETA 明细时回退（etaHours 缺数据归一） */
      normalNoEta: '{wave} · {progress}，预算{binding}',
      progressEarly: '推进中 {covered}/{total}',
      progressHalf: '已过半 {covered}/{total}',
      progressDone: '已达标 {covered}/{total}',
      /** 无覆盖数据时的定性进度词 */
      progressNoData: '推进中',
      bindingSufficient: '充足',
      bindingTight: '偏紧',
      bindingInsufficient: '不足',
      bindingUnknown: '未知',
      strategyNameNormal: '正常推进',
      strategyNameConvergeFirst: '收敛优先',
      strategyNameDeepDive: '攻坚深挖',
      strategyNameSteadyRegression: '稳健回归',
      strategyReasonConvergeFirst: '：先收敛 {count} 个未决闭环项再提速',
      strategyReasonDeepDive: '：集中攻坚 {count} 个未闭环场景',
      strategyReasonSteadyRegression: '：优先回归巩固已有通过项',
      /** confidence=low 附注：预测仅供参考 */
      forecastNote: '（速率样本不足，预测仅供参考）',
      /** 一个数：闭环率（唯一常驻硬指标） */
      coverage: '已验证 {covered}/{total}',
      /** 闭环率 + 陈旧通过透出 */
      coverageStale: '已验证 {covered}/{total}，含 {stale} 条待回归',
      coverageNone: '尚无覆盖数据',
      /** 波段缺失占位 */
      waveUnknown: '—',
      /** 预算琥珀警示：维度名 */
      dimSteps: '循环步数',
      dimTokens: 'Token',
      dimWall: '墙钟',
      /** 预算琥珀警示：预计够/不够（由 forecast.binding 裁决） */
      budgetEnough: '够',
      budgetShort: '不够',
      budgetWarning: '{dimension}预算已用 {percent}%（{used}/{max}），预计{verdict}'
    }
  },
  fix: {
    title: 'RTL 修复',
    empty: '尚无修复记录',
    stateFixing: '修复中',
    judgment: {
      FIXED: '已修复',
      STILL_FAIL: '仍失败',
      UNKNOWN: '未知'
    },
    recordMissing: '未找到对应根因记录',
    startedAt: '开始于 {time}',
    settledAt: '判定于 {time}',
    continueDiagnosis: '继续诊断',
    rerunRegression: '去重跑回归',
    auditToggle: '审计 diff 与拦截记录',
    auditMissing: '审计文件尚未加载',
    noFileChanges: '窗口内无文件变更',
    auditChanged: '修改',
    auditCreated: '新增',
    auditDeleted: '删除',
    blockedAttempts: '写保护拦截 {count} 次',
    unknownReason: '修复后未重跑回归'
  },
  window: {
    banner: 'RTL 修复进行中（根因 {rootCauseId} / 场景 {scenarioId}），修复窗口内 rtl/ 目录处于写保护状态。',
    since: '修复开始于 {time}'
  },
  rootCause: {
    title: '根因链',
    empty: '尚无根因记录',
    count: '共 {count} 条',
    verdict: {
      open: '待验证',
      refuted: '已证伪',
      confirmed: '已确认'
    },
    refutedBy: '证伪了 {ids}',
    fixLabel: '修复：{fix}',
    recordedAt: '记录于 {time}'
  },
  diagnostic: {
    title: '诊断账本',
    empty: '尚无诊断尝试记录',
    timelineTitle: '诊断过程',
    attemptCount: '{count} 次尝试',
    fingerprint: '失败指纹 {signature}',
    sameFingerprint: '同指纹 {count} 次',
    enhancementEntered: '进入增强诊断',
    triggerSameFingerprint: '触发条件：同指纹失败 ≥ 2 次',
    triggerStalled: '触发条件：≥ 3 次尝试且诊断等级未爬升',
    ladderTitle: '诊断等级爬升（L0 → L5）',
    level: 'L{level}',
    passed: '通过',
    failed: '失败',
    duration: '{ms} ms',
    colTime: '时间',
    colTestcase: '用例',
    colResult: '结果',
    colLevel: '等级',
    colDuration: '耗时',
    colEvidence: '证据',
    openEvidence: '打开证据文件',
    utEscalationsTitle: 'UT 例外登记（{count}）',
    utEscalationActive: 'active',
    utEscalationRetired: '已退役',
    utEscalationRootCause: '关联根因记录'
  },
  ut: {
    title: '模块 UT',
    start: '发起模块 UT',
    activeBadge: 'UT 进行中 ×{count}',
    activeLine: '模块 UT 进行中（{count} 个）：{modules} —— 主循环互斥挂起中',
    activeNoNames: '模块 UT 进行中（{count} 个）—— 主循环互斥挂起中',
    idleHint: '对某个 RTL 子模块发起独立 UT 会话：最简环境快速迭代（probe 隔离，不进主验证证据链）。',
    dialogTitle: '发起模块 UT',
    modulePlaceholder: '输入或选择 rtl/ 下的模块名',
    confirm: '发起',
    starting: '派发中…',
    emptyModule: '请输入模块名',
  }
}
