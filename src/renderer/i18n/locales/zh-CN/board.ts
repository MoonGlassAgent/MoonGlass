/** 流程看板（BoardPage）文案：阶段列、任务卡、尝试记录、空态与错误态（BOARD-AND-REVIEW-CLOSED-LOOP 片 C） */

export const board = {
  title: '流程看板',
  subtitle: '阶段 → 任务 → 尝试 三层事实（只读视图）',
  navWorkspace: '返回工作区',
  refresh: '刷新',
  reload: '重新加载',
  updatedAt: '账本更新：{time}',
  taskCount: '{count} 项任务',
  status: {
    success: '成功',
    running: '进行中',
    needsFix: '要求修改',
    pendingHuman: '待人处置',
    notStarted: '未开始'
  },
  kind: {
    batch: '验证批次',
    rtlFix: 'RTL 修复',
    designReview: '设计审查',
    moduleUt: '模块 UT',
    decision: '决策提案',
    runLoop: '运行循环'
  },
  verdict: {
    success: '成功',
    failed: '失败',
    noEvidence: '证据不足',
    circuitBroken: '熔断',
    error: '异常',
    running: '进行中'
  },
  attempts: {
    title: '尝试记录',
    indexLabel: '第 {index} 次',
    empty: '尚无尝试记录',
    colModel: '模型',
    colVerdict: '判定',
    colStartedAt: '开始',
    colSettledAt: '结算',
    colDuration: '耗时',
    colNote: '备注',
    unknownModel: '未登记',
    durationMinutes: '{minutes} 分 {seconds} 秒',
    durationSeconds: '{seconds} 秒'
  },
  pendingHuman: '待人工处置',
  loading: '加载中…',
  empty: {
    title: '暂无流程任务',
    hint: '本项目还没有批次 / 修复 / 审查 / UT / 决策任务记录；任务产生后即可在此查看。'
  },
  error: {
    title: '看板加载失败',
    hint: '读取流程账本时出错：{message}'
  }
}

export type BoardMessages = typeof board
