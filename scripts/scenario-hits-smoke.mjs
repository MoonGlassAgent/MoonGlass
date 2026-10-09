// 直测 moonglass-tools.ts 中 writeScenarioHits 的合并逻辑：
// 首次写入、按 ID 更新、保留他人条目、FAIL 登记、testcase 名解析、显式参数优先、未绑定提示、
// 证据通道 channel 写入与缺省归一、tool 字段、静态通道 FAIL 登记、旧无 channel 数据兼容。
// moonglass-tools.ts 依赖 pi 运行时（typebox、无扩展名导入），无法被 node 直接加载，
// 因此从源码按花括号配对提取 writeScenarioHits 及其依赖的纯函数（filesHash/writeJsonAtomic），
// 拼装为临时 TS 模块后用 node 类型擦除直接执行——测试的就是发布源码本身。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')

function extractFunction(declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`moonglass-tools.ts 中未找到：${declaration}`)
  let depth = 0
  const bodyStart = source.indexOf('{', start)
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${declaration} 花括号不配对`)
}

const extracted = [
  extractFunction('function filesHash('),
  extractFunction('function writeJsonAtomic('),
  extractFunction('function normalizeFailureLines('),
  extractFunction('function failureSignature('),
  extractFunction('function failureSummary('),
  extractFunction('export function writeScenarioHits(')
].join('\n\n')

const moduleDir = mkdtempSync(join(tmpdir(), 'moonglass-scenario-hits-'))
const modulePath = join(moduleDir, 'write-scenario-hits.ts')
writeFileSync(modulePath, `import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// 引擎统一口径哈希桩（真实实现由引擎 computeRtlHash 提供；桩用于验证工具调用的是统一口径）
const ENGINE_HASH_SENTINEL = 'e'.repeat(64)
function computeRtlHash() { return ENGINE_HASH_SENTINEL }

${extracted}

export { failureSignature, failureSummary }
`, 'utf-8')

const { writeScenarioHits, failureSignature, failureSummary } = await import(pathToFileURL(modulePath).href)

const workspace = mkdtempSync(join(tmpdir(), 'moonglass-scenario-hits-ws-'))
mkdirSync(join(workspace, 'rtl'), { recursive: true })
const rtlFile = join(workspace, 'rtl', 'dma.v')
writeFileSync(rtlFile, 'module dma; endmodule\n', 'utf-8')
const resultsDir = join(workspace, 'verification', 'results', 'dma')
mkdirSync(resultsDir, { recursive: true })
writeFileSync(join(resultsDir, 'result.json'), '{"passed":true}', 'utf-8')
writeFileSync(join(resultsDir, 'simulation.log'), 'sim log\n', 'utf-8')
writeFileSync(join(resultsDir, 'dma.vcd'), 'wave\n', 'utf-8')
const hitsPath = join(resultsDir, 'scenario_hits.json')
const evidence = [join(resultsDir, 'result.json'), join(resultsDir, 'simulation.log'), join(resultsDir, 'dma.vcd')]
const readHits = () => JSON.parse(readFileSync(hitsPath, 'utf-8'))

// 1. 首次写入：显式 scenarioIds，PASS 登记
const first = writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-AAAAAAAA'], passed: true, rtlFiles: [rtlFile], evidence })
if (first.registered.join(',') !== 'SCN-AAAAAAAA' || first.warnings.length !== 0) throw new Error('首次写入返回异常')
let hits = readHits()
let entry = hits.scenarios.find((item) => item.id === 'SCN-AAAAAAAA')
if (!entry || entry.reached !== true || entry.passed !== true || entry.reachCount !== 1) throw new Error('首次写入条目字段错误')
if (!entry.rtlHash || entry.rtlHash.length !== 64) throw new Error('首次写入缺少 RTL Hash')
if (entry.rtlHash !== 'e'.repeat(64)) throw new Error('rtlHash 未使用引擎统一口径（computeRtlHash）')
if (!entry.evidence.includes('result.json') || !entry.evidence.includes('simulation.log') || !entry.evidence.includes('dma.vcd')) throw new Error('证据未落为相对路径')
if (!entry.generatedAt) throw new Error('缺少 generatedAt')

// 2. 按 ID 更新：reachCount 递增、证据去重合并
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-AAAAAAAA'], passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-AAAAAAAA')
if (entry.reachCount !== 2) throw new Error('按 ID 更新未递增 reachCount')
if (entry.evidence.length !== 3) throw new Error('证据合并未去重')

// 3. 保留他人条目：预置另一场景条目不被覆盖
hits.scenarios.push({ id: 'SCN-OTHER00', reached: true, passed: true, reachCount: 5, rtlHash: 'other-hash', evidence: ['other.xml'], generatedAt: '2026-01-01T00:00:00.000Z' })
writeFileSync(hitsPath, JSON.stringify(hits, null, 2), 'utf-8')
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-AAAAAAAA'], passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
const other = hits.scenarios.find((item) => item.id === 'SCN-OTHER00')
if (!other || other.reachCount !== 5 || other.rtlHash !== 'other-hash') throw new Error('他人场景条目未被保留')
if (hits.scenarios.length !== 2) throw new Error('合并写产生了重复或丢失条目')

// 4. FAIL 同样登记（失败也是证据）
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-BBBBBBBB'], passed: false, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-BBBBBBBB')
if (!entry || entry.reached !== true || entry.passed !== false) throw new Error('FAIL 未登记为 reached=true/passed=false')

// 5. testcase 名解析：scn_<8位hex> 自动绑定
const parsed = writeScenarioHits(workspace, 'dma', { testcase: 'test_dma_scn_deadbeef_burst', passed: true, rtlFiles: [rtlFile], evidence })
if (parsed.registered.join(',') !== 'SCN-DEADBEEF') throw new Error('testcase 名解析失败')
hits = readHits()
if (!hits.scenarios.some((item) => item.id === 'SCN-DEADBEEF')) throw new Error('解析出的场景未写入')

// 6. 显式参数与 testcase 解析不一致：警告并以显式参数为准
const conflict = writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-AAAAAAAA'], testcase: 'test_scn_11111111', passed: true, rtlFiles: [rtlFile], evidence })
if (!conflict.warnings.some((item) => item.includes('不一致'))) throw new Error('显式/解析不一致未产生警告')
if (conflict.registered.join(',') !== 'SCN-AAAAAAAA') throw new Error('不一致时未以显式参数为准')

// 7. 未绑定场景：不写入，仅提示
const workspace2 = mkdtempSync(join(tmpdir(), 'moonglass-scenario-hits-ws2-'))
const unbound = writeScenarioHits(workspace2, 'dma', { testcase: 'test_plain_regression', passed: true, rtlFiles: [rtlFile], evidence })
if (unbound.registered.length !== 0 || !unbound.warnings.some((item) => item.includes('未绑定场景'))) throw new Error('未绑定场景时返回异常')
if (existsSync(join(workspace2, 'verification', 'results', 'dma', 'scenario_hits.json'))) throw new Error('未绑定场景时不应创建 scenario_hits.json')

// 8. BUG-VERIF-BIND-001：scenarioIds 路径的用例反向指针
// 8a. 单用例运行：用例名提升为所有显式绑定场景的精确 testName，boundBy=testcase-name
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-CCCCCCCC'], passed: true, rtlFiles: [rtlFile], evidence, runTestcases: ['test_single_case'] })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-CCCCCCCC')
if (!entry || entry.testName !== 'test_single_case' || entry.boundBy !== 'testcase-name') throw new Error(`单用例精确绑定失败：${JSON.stringify(entry)}`)
if (!Array.isArray(entry.boundTestcases) || entry.boundTestcases.join(',') !== 'test_single_case') throw new Error('单用例未写入 boundTestcases')

// 8b. 多用例运行：整组记入 boundTestcases，boundBy=scenarioIds，不写精确 testName
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-DDDDDDDD'], passed: true, rtlFiles: [rtlFile], evidence, runTestcases: ['test_batch_a', 'test_batch_b'] })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-DDDDDDDD')
if (!entry || entry.testName !== undefined || entry.boundBy !== 'scenarioIds') throw new Error(`多用例批次绑定失败：${JSON.stringify(entry)}`)
if (entry.boundTestcases.join(',') !== 'test_batch_a,test_batch_b') throw new Error('多用例 boundTestcases 未整组登记')

// 8c. 批次绑定跨次合并去重
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-DDDDDDDD'], passed: true, rtlFiles: [rtlFile], evidence, runTestcases: ['test_batch_b', 'test_batch_c'] })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-DDDDDDDD')
if (entry.boundTestcases.join(',') !== 'test_batch_a,test_batch_b,test_batch_c') throw new Error('boundTestcases 跨次合并未去重')

// 8d. 名称解析路径（scn_<hex>）精确 testName 与 boundTestcases 并存
writeScenarioHits(workspace, 'dma', { testcase: 'test_dma_scn_eeeeeeee_wrap', passed: true, rtlFiles: [rtlFile], evidence, testNames: { 'SCN-EEEEEEEE': 'test_dma_scn_eeeeeeee_wrap' }, runTestcases: ['test_dma_scn_eeeeeeee_wrap'] })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-EEEEEEEE')
if (!entry || entry.testName !== 'test_dma_scn_eeeeeeee_wrap' || entry.boundBy !== 'testcase-name') throw new Error(`名称解析路径 testName 缺失：${JSON.stringify(entry)}`)

// 9. 方案 C 批 1（§3.3）：FAIL 登记携带失败摘要/指纹
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-FFFFFFFF'], passed: false, rtlFiles: [rtlFile], evidence, failureSummary: 'assert data mismatch: got <hex>', failureSignature: 'abc123def456' })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-FFFFFFFF')
if (!entry || entry.passed !== false) throw new Error('FAIL 登记失败')
if (entry.failureSummary !== 'assert data mismatch: got <hex>' || entry.failureSignature !== 'abc123def456') throw new Error(`FAIL 未携带失败摘要/指纹：${JSON.stringify(entry)}`)

// 10. PASS 路径不写这两个字段——并清掉上一次 FAIL 留下的旧值
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-FFFFFFFF'], passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-FFFFFFFF')
if (!entry || entry.passed !== true) throw new Error('FAIL 后转 PASS 登记失败')
if ('failureSummary' in entry || 'failureSignature' in entry) throw new Error(`PASS 后仍残留失败字段：${JSON.stringify(entry)}`)

// 11. 旧数据兼容：无新字段的条目按旧口径 FAIL 登记（不带新字段）不报错、字段不凭空出现
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-99999999'], passed: false, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-99999999')
if (!entry || entry.passed !== false) throw new Error('旧口径 FAIL 登记失败')
if ('failureSummary' in entry || 'failureSignature' in entry) throw new Error('未提供新字段时不应凭空出现')

// 12. failureSummary/failureSignature 生成算法：与 diagnostic-control 同一归一化（路径/时间/hex/大数字脱敏）
const failLog = [
  'INFO: start sim at D:\\proj\\sim_build',
  '     1200.00ns ERROR: axi burst mismatch exp 0xdeadbeef got 0x1234',
  'INFO: retry 4096 cycles',
  'FAIL: test_scn_aaaaaaaa timed out after 50000ns'
].join('\n')
const summary = failureSummary(failLog)
if (summary !== '<time> ERROR: axi burst mismatch exp <hex> got <hex>') throw new Error(`failureSummary 归一化/首个错误行取值错误：${summary}`)
const signature = failureSignature(failLog)
if (!/^[0-9a-f]{12}$/.test(signature)) throw new Error(`failureSignature 不是 12 位 hex：${signature}`)
if (failureSignature(failLog) !== signature) throw new Error('failureSignature 对同一日志不稳定')
const truncated = failureSummary(`ERROR: ${'x'.repeat(300)}`)
if (truncated.length !== 160) throw new Error(`failureSummary 未做 160 字硬截断：${truncated.length}`)
if (failureSummary('INFO: all good\nPASS: ok') !== '') throw new Error('无错误行时 failureSummary 应为空串')

// 13. BUG-VERIF-BATCH-001：证据通道 channel 与登记工具 tool
// 13a. 缺省 channel 归一为 'simulation' 且始终写入；未提供 tool 时不写 tool 字段
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-11111111'], passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-11111111')
if (!entry || entry.channel !== 'simulation') throw new Error(`缺省 channel 未归一为 simulation：${JSON.stringify(entry)}`)
if ('tool' in entry) throw new Error(`未提供 tool 时不应写入 tool 字段：${JSON.stringify(entry)}`)

// 13b. 静态通道 FAIL 登记：channel/tool 忠实落盘，失败同样是证据（模拟 run_verible_lint 登记路径）
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-22222222'], channel: 'static', tool: 'run_verible_lint', passed: false, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-22222222')
if (!entry || entry.reached !== true || entry.passed !== false) throw new Error('静态通道 FAIL 未登记为 reached=true/passed=false')
if (entry.channel !== 'static' || entry.tool !== 'run_verible_lint') throw new Error(`静态通道 FAIL 登记缺 channel/tool：${JSON.stringify(entry)}`)

// 13c. synthesis 通道 + 工具名（模拟 run_logic_synthesis 登记路径）
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-33333333'], channel: 'synthesis', tool: 'run_logic_synthesis', passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-33333333')
if (!entry || entry.channel !== 'synthesis' || entry.tool !== 'run_logic_synthesis') throw new Error(`synthesis 通道登记缺 channel/tool：${JSON.stringify(entry)}`)

// 13d. 旧数据兼容：预置无 channel 的旧条目，合并写读取不炸、不被凭空补字段；重新登记后按新口径补 channel
hits.scenarios.push({ id: 'SCN-LEGACY00', reached: true, passed: true, reachCount: 3, rtlHash: 'legacy-hash', evidence: ['legacy.xml'], generatedAt: '2026-01-01T00:00:00.000Z' })
writeFileSync(hitsPath, JSON.stringify(hits, null, 2), 'utf-8')
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-AAAAAAAA'], passed: true, rtlFiles: [rtlFile], evidence })
hits = readHits()
const legacy = hits.scenarios.find((item) => item.id === 'SCN-LEGACY00')
if (!legacy || legacy.reachCount !== 3) throw new Error('旧无 channel 条目在合并写后未被原样保留')
if ('channel' in legacy || 'tool' in legacy) throw new Error(`旧无 channel 条目被凭空补字段：${JSON.stringify(legacy)}`)
writeScenarioHits(workspace, 'dma', { scenarioIds: ['SCN-LEGACY00'], channel: 'static', tool: 'check_dead_logic', passed: false, rtlFiles: [rtlFile], evidence })
hits = readHits()
entry = hits.scenarios.find((item) => item.id === 'SCN-LEGACY00')
if (entry.channel !== 'static' || entry.tool !== 'check_dead_logic' || entry.passed !== false) throw new Error(`旧条目重新登记未按新口径写 channel/tool：${JSON.stringify(entry)}`)

console.log('Scenario hits smoke passed: 首次写入/按ID更新/保留他人条目/FAIL登记/testcase解析/显式优先/未绑定提示/绑定反向指针(单用例精确/多例批次/合并去重/名称解析)/失败摘要指纹(FAIL携带/PASS清除/旧数据兼容/归一化截断)/证据通道(channel缺省归一/static FAIL登记/synthesis通道/tool字段/旧无channel数据兼容)')
