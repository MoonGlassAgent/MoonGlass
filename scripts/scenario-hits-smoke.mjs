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

console.log('Scenario hits smoke passed: 首次写入/按ID更新/保留他人条目/FAIL登记/testcase解析/显式优先/未绑定提示')
