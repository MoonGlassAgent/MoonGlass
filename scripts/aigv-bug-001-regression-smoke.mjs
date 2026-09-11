/**
 * BUG-AIGV-001 回归冒烟（R10 CDC 误报 + 陈旧 Formal 证据覆盖）
 *
 * D1：R10 改为结构事实判定后——
 *   样例 B（单时钟 + 注释/标识符多次出现 sync）不得再产出 R10 风险；
 *   样例 C（单时钟 + 注释含 "no CDC"）不得产出 R10 风险；
 *   样例 A（真实双时钟）仍必须产出 R10 风险（防过收敛漏报）。
 * D2：陈旧 Formal 结果（rtlHash ≠ 当前）不得覆盖当前仿真 hit；
 *   hit 自身 rtlHash 陈旧时 freshness 判 IMPACT_UNKNOWN 并把 FORMAL_PROVED 降级 PARTIAL。
 *
 * 运行：node scripts/aigv-bug-001-regression-smoke.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-aigv-bug-001-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# DID Requirements

- REQ-001 P0: 单时钟域设计，无跨时钟路径。
`, 'utf-8')

// 样例 B：单时钟，注释与标识符中多次出现 sync（原 R10 文本规则必误报）
writeFileSync(join(root, 'rtl', 'ddr_reset_sync.v'), `
// Module    : ddr_reset_sync
// Description: Asynchronous assert / synchronous deassert reset synchronizer.
module ddr_reset_sync(input i_clk, input i_rst_n, output reg w_rst_n_sync);
  reg r_meta;
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) begin r_meta <= 0; w_rst_n_sync <= 0; end
    else begin r_meta <= 1; w_rst_n_sync <= r_meta; end
  end
endmodule
`, 'utf-8')

// 样例 C：单时钟，文件头注释含 "single clock domain, no CDC"
writeFileSync(join(root, 'rtl', 'no_cdc_comment.v'), `
// All logic belongs to i_clk (single clock domain, no CDC); i_rst_n is
//   async assert / sync deassert.
module no_cdc_comment(input i_clk, input i_rst_n, input advance, output reg [7:0] cnt);
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) cnt <= 0;
    else if (advance) cnt <= cnt + 1;
  end
endmodule
`, 'utf-8')

// 样例 A：真实双时钟（i_clk + i_clk_axi + 2-flop 同步器），必须判为 CDC
writeFileSync(join(root, 'rtl', 'real_cdc.v'), `
module real_cdc(input i_clk, input i_clk_axi, input i_rst_n, input req_in, output reg req_axi);
  reg req_meta;
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) req_meta <= 0;
    else req_meta <= req_in;
  end
  always @(posedge i_clk_axi or negedge i_rst_n) begin
    if (!i_rst_n) req_axi <= 0;
    else req_axi <= req_meta;
  end
endmodule
`, 'utf-8')

try {
  // ==================== D1：R10 结构事实判定 ====================
  buildVerificationIntelligence(root)
  const riskRegister = JSON.parse(readFileSync(join(root, 'verification', 'intelligence', 'risk-register.json'), 'utf-8'))
  const r10Objects = riskRegister.risks.filter((risk) => risk.taxonomyId === 'R10').map((risk) => risk.object)
  if (r10Objects.includes('ddr_reset_sync')) throw new Error('D1 回归失败：单时钟 ddr_reset_sync 仍被 R10 误判（样例 B）')
  if (r10Objects.includes('no_cdc_comment')) throw new Error('D1 回归失败：注释含 "no CDC" 的单时钟模块仍被 R10 误判（样例 C）')
  if (!r10Objects.includes('real_cdc')) throw new Error('D1 回归失败：真实双时钟 real_cdc 未被 R10 捕获（样例 A，过收敛漏报）')

  // ==================== D2：陈旧 Formal 证据 ====================
  const registryPath = join(root, 'verification', 'intelligence', 'scenario-registry.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'))
  const rtlHash = registry.rtlHash
  const template = registry.scenarios[0]
  if (!template) throw new Error('回归夹具异常：首轮未产生任何场景')

  const mkScenario = (id, status) => ({
    ...template,
    id, origin: 'AGENT_INTENT', status, rtlHash,
    state: { ...template.state, freshness: 'CURRENT' },
    evidence: [], reachCount: 0, coverageDelta: {}
  })
  registry.scenarios.push(mkScenario('SCN-D2TEST01', 'FORMAL_PROVED'), mkScenario('SCN-D2TEST02', 'VERIFIED'))
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8')

  // 两个场景各一条陈旧 Formal 结果（rtlHash 与当前不一致）
  mkdirSync(join(root, 'verification', 'formal', 'results', 'f_stale'), { recursive: true })
  const staleFormal = (scenarioId) => ({ status: 'PASS', outcome: 'PROVEN', mode: 'prove', scenarioId, rtlHash: 'STALE_RTL_HASH', propertyFiles: [], traces: [] })
  writeFileSync(join(root, 'verification', 'formal', 'results', 'f_stale', 'formal-result.json'), JSON.stringify(staleFormal('SCN-D2TEST01')), 'utf-8')
  mkdirSync(join(root, 'verification', 'formal', 'results', 'f_stale2'), { recursive: true })
  writeFileSync(join(root, 'verification', 'formal', 'results', 'f_stale2', 'formal-result.json'), JSON.stringify(staleFormal('SCN-D2TEST02')), 'utf-8')

  // SCN-D2TEST02 另有当前仿真 hit（VERIFIED + 当前 rtlHash + 两份有效证据）
  const simDir = join(root, 'verification', 'results', 'tb')
  mkdirSync(simDir, { recursive: true })
  writeFileSync(join(simDir, 'ev1.log'), 'pass\n', 'utf-8')
  writeFileSync(join(simDir, 'ev2.log'), 'pass\n', 'utf-8')
  writeFileSync(join(simDir, 'scenario_hits.json'), JSON.stringify({
    rtlHash,
    scenarios: [{ id: 'SCN-D2TEST02', status: 'VERIFIED', reached: true, passed: true, reachCount: 1, rtlHash, evidence: ['ev1.log', 'ev2.log'] }]
  }), 'utf-8')

  buildVerificationIntelligence(root)
  const after = JSON.parse(readFileSync(registryPath, 'utf-8'))
  const s1 = after.scenarios.find((item) => item.id === 'SCN-D2TEST01')
  const s2 = after.scenarios.find((item) => item.id === 'SCN-D2TEST02')
  if (s1?.status !== 'PARTIAL' || s1?.state?.freshness !== 'IMPACT_UNKNOWN') {
    throw new Error(`D2 回归失败：陈旧 Formal 支撑的 SCN-D2TEST01 应降级 PARTIAL/IMPACT_UNKNOWN，实际 ${s1?.status}/${s1?.state?.freshness}`)
  }
  if (s2?.status !== 'VERIFIED' || s2?.state?.freshness !== 'CURRENT') {
    throw new Error(`D2 回归失败：当前仿真 hit 被陈旧 Formal 覆盖，SCN-D2TEST02 应保持 VERIFIED/CURRENT，实际 ${s2?.status}/${s2?.state?.freshness}`)
  }

  console.log('BUG-AIGV-001 regression smoke passed: R10 结构判定（A/B/C 样例）+ 陈旧 Formal 证据处理（降级/不覆盖）')
} finally {
  rmSync(root, { recursive: true, force: true })
}
