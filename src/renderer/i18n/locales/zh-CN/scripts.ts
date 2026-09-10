/** Python 脚本管理页文案 */

export const scripts = {
  title: 'Python 脚本',
  subtitle: '脚本模板库占位（Phase 2 升级为 Notebook Cell 交互 + 项目级 venv）',
  templates: {
    rtlBatch: { name: 'RTL 批量生成', description: '基于参数化配置批量生成 RTL 模块' },
    regTable: { name: '寄存器表生成', description: '由规格表生成寄存器 RTL 与文档' },
    waveAnalysis: { name: '波形分析', description: '解析 VCD 波形并统计信号翻转' },
    coverageParse: { name: '覆盖率解析', description: '解析覆盖率报告生成摘要' },
    sdcGen: { name: 'SDC 生成', description: '由时钟规格生成 SDC 约束文件' }
  },
  quickRun: {
    title: '快速执行（冒烟验证）',
    run: '▶ 运行',
    running: '运行中…'
  }
}

export type ScriptsMessages = typeof scripts
