/**
 * AIGV 修订批 3：sim-passed 门禁收紧冒烟（TOP 优先，UT 例外；§6）
 *
 * 不依赖外部 EDA 工具（lint/yosys 不参与，只跑 VERIF→QA 门禁并取 sim-passed 结果）。
 * 覆盖口径：
 *   1. 无任何 result.json → 失败
 *   2. TOP 识别（rtl/design.json manifest topModule，与引擎同一来源）但证据缺失 → 指名 TOP 证据缺失
 *   3. TOP 证据存在但 passed != true → 指名 TOP 仿真未通过
 *   4. active UT 例外模块（ut-escalations.json）证据缺失 → 指名例外模块证据缺失
 *   5. retired 例外不要求模块证据；全部必过证据齐备 → 通过且消息点名 TOP/例外模块
 *   6. TOP 未识别（无 manifest / topModule 悬空）→ 回退任意模块证据放行并标注
 *   7. rtlHash 与当前 RTL 不一致 → 陈旧证据拒绝（防线不变）
 * 运行：node scripts/sim-passed-gate-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { PhaseEngine } = await import('../src/main/services/PhaseEngine.ts')
const { computeRtlHash } = await import('../packages/verification-intelligence-engine/src/index.ts')

const RTL = `module top_mod(input wire i_clk, input wire i_rst_n, output wire [3:0] o_state);
  wire [3:0] sub_state;
  sub_a u_sub(.i_clk(i_clk), .i_rst_n(i_rst_n), .o_state(sub_state));
  assign o_state = sub_state;
endmodule

module sub_a(input wire i_clk, input wire i_rst_n, output reg [3:0] o_state);
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) o_state <= 4'd0;
    else          o_state <= o_state + 4'd1;
  end
endmodule
`

const root = mkdtempSync(join(tmpdir(), 'moonglass-sim-passed-gate-'))
const ws = join(root, 'ws')
mkdirSync(join(ws, 'rtl'), { recursive: true })
writeFileSync(join(ws, 'rtl', 'top_mod.v'), RTL, 'utf-8')
writeFileSync(join(ws, 'rtl', 'filelist.f'), 'top_mod.v\n', 'utf-8')
writeFileSync(join(ws, 'rtl', 'design.json'), JSON.stringify({ topModule: 'top_mod', filelist: 'filelist.f' }, null, 2), 'utf-8')

const rtlHash = computeRtlHash(ws)
const resultsOf = (module) => join(ws, 'verification', 'results', module)
const writeResult = (module, data) => {
  mkdirSync(resultsOf(module), { recursive: true })
  writeFileSync(join(resultsOf(module), 'result.json'), JSON.stringify(data, null, 2), 'utf-8')
}
const passedResult = () => ({ passed: true, testsTotal: 2, coverage: { lineCoverage: 95 }, rtlHash })
const writeEscalations = (status) => {
  mkdirSync(join(ws, 'verification', 'results'), { recursive: true })
  writeFileSync(join(ws, 'verification', 'results', 'ut-escalations.json'), JSON.stringify({
    version: 1,
    escalations: [{
      id: 'UTX-SMOKE01',
      module: 'sub_a',
      reason: 'TOP 激励无法观测子模块内部计数器状态，probe 后仍无法定位',
      failureSignature: 'sig-smoke',
      rootCauseId: null,
      topScenarioIds: [],
      createdAt: new Date().toISOString(),
      status,
      retiredReason: status === 'retired' ? '根因修复且 TOP 回归已覆盖' : null
    }]
  }, null, 2), 'utf-8')
}
const clearEscalations = () => {
  const path = join(ws, 'verification', 'results', 'ut-escalations.json')
  if (existsSync(path)) rmSync(path)
}

const engine = new PhaseEngine()
const fakeProject = (phase) => ({ currentPhase: phase })
// 只关心 sim-passed 结果；同一次 runGateChecks 里的覆盖率/闭环门禁失败不影响本冒烟断言
const simPassedOf = async (dir) =>
  (await engine.runGateChecks(fakeProject('VERIF'), 'QA', { workspaceDir: dir })).find((result) => result.checkId === 'sim-passed')

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`)
  if (!cond) failures++
}

// 1. 无任何 result.json
const none = await simPassedOf(ws)
check('无 result.json 时阻断', none?.passed === false && none.message.includes('result.json 不存在'), none?.message)

// 2. TOP 识别但证据缺失（只有非 TOP 模块证据）
writeResult('sub_a', passedResult())
const topMissing = await simPassedOf(ws)
check(
  'TOP 证据缺失被阻断并指名',
  topMissing?.passed === false && topMissing.message.includes('TOP 证据缺失') && topMissing.message.includes('top_mod') && topMissing.message.includes('以 TOP 为 DUT 跑一次回归'),
  topMissing?.message
)

// 3. TOP 证据存在但 passed != true
writeResult('top_mod', { ...passedResult(), passed: false })
const topFailed = await simPassedOf(ws)
check(
  'TOP 仿真未通过被阻断并指名',
  topFailed?.passed === false && topFailed.message.includes('TOP 仿真未通过') && topFailed.message.includes('top_mod'),
  topFailed?.message
)

// 4. active UT 例外模块证据缺失
writeResult('top_mod', passedResult())
rmSync(resultsOf('sub_a'), { recursive: true, force: true })
writeEscalations('active')
const utMissing = await simPassedOf(ws)
check(
  'UT 例外模块证据缺失被阻断并指名',
  utMissing?.passed === false && utMissing.message.includes('UT 例外模块证据缺失') && utMissing.message.includes('sub_a') && utMissing.message.includes('ut-escalations.json'),
  utMissing?.message
)

// 5a. 例外模块证据齐备 → 通过，消息点名 TOP 与例外模块
writeResult('sub_a', passedResult())
const allGreen = await simPassedOf(ws)
check(
  'TOP + active UT 例外证据齐备时通过并点名',
  allGreen?.passed === true && allGreen.message.includes('TOP top_mod') && allGreen.message.includes('sub_a'),
  allGreen?.message
)

// 5b. retired 例外不再要求模块证据（删掉 sub_a 证据 + 例外退役 → 仍通过）
rmSync(resultsOf('sub_a'), { recursive: true, force: true })
writeEscalations('retired')
const retiredOk = await simPassedOf(ws)
check('retired 例外不要求模块证据', retiredOk?.passed === true, retiredOk?.message)
clearEscalations()

// 6a. TOP 未识别（manifest 移除）→ 回退任意模块证据放行并标注
const manifestPath = join(ws, 'rtl', 'design.json')
const manifestBak = join(ws, 'rtl', 'design.json.bak')
renameSync(manifestPath, manifestBak)
// 回退口径下 rtlHash 口径不变（design.json 不参与哈希），既有证据仍新鲜
const fallback = await simPassedOf(ws)
check(
  'TOP 未识别回退任意模块证据并标注',
  fallback?.passed === true && fallback.message.includes('TOP 未识别，按任意模块证据放行（建议补 design.json）'),
  fallback?.message
)

// 6b. manifest 存在但 topModule 悬空（无此模块）→ 同样回退
writeFileSync(manifestPath, JSON.stringify({ topModule: 'ghost_top', filelist: 'filelist.f' }, null, 2), 'utf-8')
const ghostTop = await simPassedOf(ws)
check(
  'topModule 悬空时回退任意模块证据并标注',
  ghostTop?.passed === true && ghostTop.message.includes('TOP 未识别'),
  ghostTop?.message
)
rmSync(manifestPath)
renameSync(manifestBak, manifestPath)

// 7. 陈旧证据拒绝（rtlHash 与当前 RTL 不一致）
writeResult('top_mod', { ...passedResult(), rtlHash: 'deadbeefcafe' })
writeResult('sub_a', passedResult())
const stale = await simPassedOf(ws)
check(
  '陈旧证据（rtlHash 不一致）被拒绝',
  stale?.passed === false && stale.message.includes('已过期') && stale.message.includes('重新运行 run_simulation'),
  stale?.message
)

rmSync(root, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '✅ sim-passed 门禁冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
