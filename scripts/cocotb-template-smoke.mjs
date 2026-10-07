// cocotb 技能模板冒烟（测试级超时兜底）：
// 1. 资产 test.py：所有 @cocotb.test 均带 timeout_time/timeout_unit（cocotb 2.x API），
//    且缺省 default_timeout=5000 us（= 5_000_000 ns，对真实项目可辩护的默认值）。
// 2. gen_cocotb_env.py 实际生成测试文件：timeout_time/timeout_unit 齐全、缺省值正确，
//    且留有按测试覆盖的口子（各测试用不同倍率）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const assetPath = join('resources', 'moonglass', 'skills', 'cocotb-verification', 'assets', 'test.py')
const genPath = join('resources', 'moonglass', 'skills', 'cocotb-verification', 'scripts', 'gen_cocotb_env.py')

// ============ 用例 1：资产模板——每个 @cocotb.test 都有超时兜底 ============
{
  const content = readFileSync(assetPath, 'utf-8')
  const decoratorCount = (content.match(/@cocotb\.test\(/g) ?? []).length
  const timeoutCount = (content.match(/timeout_time\s*=/g) ?? []).length
  check('资产模板每个 @cocotb.test 都带 timeout_time', decoratorCount > 0 && decoratorCount === timeoutCount,
    `@cocotb.test=${decoratorCount} timeout_time=${timeoutCount}`)
  check('资产模板使用 timeout_unit（us）', /timeout_unit\s*=\s*'us'/.test(content))
  check('资产模板缺省 default_timeout=5000 us（= 5_000_000 ns）',
    content.includes("'default_timeout': 5000") && content.includes('5_000_000 ns'))
  check('资产模板留按测试覆盖的口子（不同倍率/自定义值）',
    content.includes('default_timeout') && content.includes('timeout_time=TEST_CONFIG'))
}

// ============ 用例 2：gen_cocotb_env.py 实际生成——超时兜底落到测试文件 ============
{
  const outDir = mkdtempSync(join(tmpdir(), 'moonglass-cocotb-template-smoke-'))
  try {
    execFileSync(process.platform === 'win32' ? 'python' : 'python3',
      [genPath, '--name', 'smokeip', '--output', outDir], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    const generatedPath = join(outDir, 'tests', 'test_smokeip.py')
    check('生成测试文件存在', existsSync(generatedPath), generatedPath)
    const generated = readFileSync(generatedPath, 'utf-8')
    const decoratorCount = (generated.match(/@cocotb\.test\(/g) ?? []).length
    const timeoutCount = (generated.match(/timeout_time\s*=/g) ?? []).length
    check('生成的测试文件每个 @cocotb.test 都带 timeout_time', decoratorCount > 0 && decoratorCount === timeoutCount,
      `@cocotb.test=${decoratorCount} timeout_time=${timeoutCount}`)
    check('生成的测试文件带 timeout_unit（us）', /timeout_unit\s*=\s*'us'/.test(generated))
    check('生成的测试文件缺省 default_timeout=5000 us', generated.includes("'default_timeout': 5000"))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

if (failures === 0) {
  console.log('\n✅ cocotb 模板超时兜底冒烟通过')
} else {
  console.log(`\n❌ ${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
