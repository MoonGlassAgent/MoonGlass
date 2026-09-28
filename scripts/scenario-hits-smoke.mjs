// 直测 moonglass-tools.ts 中 writeScenarioHits 的合并逻辑：
// 首次写入、按 ID 更新、保留他人条目、FAIL 登记、testcase 名解析、显式参数优先、未绑定提示。
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
`, 'utf-8')

const { writeScenarioHits } = await import(pathToFileURL(modulePath).href)

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

console.log('Scenario hits smoke passed: 首次写入/按ID更新/保留他人条目/FAIL登记/testcase解析/显式优先/未绑定提示/绑定反向指针(单用例精确/多例批次/合并去重/名称解析)')
