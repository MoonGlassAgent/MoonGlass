/**
 * 验证运行中心（VerifRunPanel / 根因链 / 诊断时间线）文案。
 * 批次进度、修复卡片、修复窗口横幅、根因链视图、诊断账本时间线。
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
    updatedAt: '更新于 {time}'
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
  }
}
