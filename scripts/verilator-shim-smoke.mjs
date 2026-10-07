// cocotb verilator shim 冒烟（PATH 前置 shim，绕过坏掉的 perl wrapper）：
// 1. 幂等生成：内容一致时 created=false 直接复用；bin 路径变更时原子重写。
// 2. 内容：verilator.cmd 调用生成时已解析绝对路径的 verilator_bin.exe，并前置
//    设置正斜杠 VERILATOR_ROOT（与 toolEnv 同口径）。
// 3. 解析口径：定位结果是 perl wrapper（无扩展名脚本）时回落同目录 verilator_bin.exe；
//    找不到 verilator_bin.exe 时明确抛错，绝不静默回退到坏 wrapper。
// 4. 功能性（本机有 verilator 时）：shim 目录前置 PATH 后，python shutil.which('verilator')
//    命中 shim（不再被 PATHEXT 解析带到 msys2 的同名坏 wrapper），且经 shim 执行
//    verilator --version 输出真实版本。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const { ensureVerilatorShim, VERILATOR_SHIM_DIR, locateTool, run, VERILATOR_CANDIDATES } = await import('../packages/eda-bridge/src/tool-runner.ts')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

// 清理共享 shim 目录，保证用例从干净状态开始（结束后会按本机真实工具链重建）
rmSync(VERILATOR_SHIM_DIR, { recursive: true, force: true })

const sandbox = mkdtempSync(join(tmpdir(), 'moonglass-verilator-shim-smoke-'))
const fwd = (p) => p.replace(/\\/g, '/')

// ============ 用例 1：幂等生成 + 内容形态（沙箱假 bin，完全 hermetic） ============
{
  const fakeBinDir = join(sandbox, 'fake-oss', 'bin')
  mkdirSync(fakeBinDir, { recursive: true })
  writeFileSync(join(fakeBinDir, 'verilator_bin.exe'), '')
  writeFileSync(join(fakeBinDir, 'verilator'), '#!/usr/bin/perl\n# 假 perl wrapper\n')

  // 直接给 verilator_bin.exe：正常生成
  const shim1 = ensureVerilatorShim(join(fakeBinDir, 'verilator_bin.exe'))
  check('首次生成 created=true', shim1.created === true)
  check('shim 目录为共享临时目录', shim1.dir === VERILATOR_SHIM_DIR)
  const content1 = readFileSync(shim1.cmdPath, 'utf-8')
  check('内容调用 verilator_bin.exe 绝对路径（正斜杠）',
    content1.includes(`"${fwd(join(fakeBinDir, 'verilator_bin.exe'))}" %*`))
  check('内容前置设置正斜杠 VERILATOR_ROOT',
    content1.includes(`set "VERILATOR_ROOT=${fwd(join(fakeBinDir, '..', 'share', 'verilator'))}"`) &&
    !content1.includes('VERILATOR_ROOT=\\'))
  check('回显 verilatorBin/verilatorRoot 与内容一致',
    shim1.verilatorBin === join(fakeBinDir, 'verilator_bin.exe') &&
    shim1.verilatorRoot === fwd(join(fakeBinDir, '..', 'share', 'verilator')))

  // 幂等：内容一致 → created=false，文件不被重写
  const beforeMtime = existsSync(shim1.cmdPath) ? readFileSync(shim1.cmdPath, 'utf-8') : ''
  const shim2 = ensureVerilatorShim(join(fakeBinDir, 'verilator_bin.exe'))
  check('二次生成 created=false（内容一致直接复用）', shim2.created === false)
  check('复用时文件内容未被改动', readFileSync(shim2.cmdPath, 'utf-8') === beforeMtime)

  // 定位结果是 perl wrapper（无扩展名脚本）→ 回落同目录 verilator_bin.exe
  const shim3 = ensureVerilatorShim(join(fakeBinDir, 'verilator'))
  check('wrapper 名定位回落到同目录 verilator_bin.exe', shim3.verilatorBin === join(fakeBinDir, 'verilator_bin.exe'))

  // bin 路径变更 → 内容不一致 → 原子重写
  const fakeBinDirB = join(sandbox, 'fake-oss-b', 'bin')
  mkdirSync(fakeBinDirB, { recursive: true })
  writeFileSync(join(fakeBinDirB, 'verilator_bin.exe'), '')
  const shim4 = ensureVerilatorShim(join(fakeBinDirB, 'verilator_bin.exe'))
  check('bin 路径变更时重写（created=true）', shim4.created === true)
  check('重写后内容指向新 bin', readFileSync(shim4.cmdPath, 'utf-8').includes(`"${fwd(join(fakeBinDirB, 'verilator_bin.exe'))}" %*`))
  check('临时文件不残留', !readFileSync(shim4.cmdPath, 'utf-8').includes('.tmp'))
}

// ============ 用例 2：缺 verilator_bin.exe 明确抛错（不静默回退坏 wrapper） ============
{
  const emptyDir = join(sandbox, 'no-bin')
  mkdirSync(emptyDir, { recursive: true })
  writeFileSync(join(emptyDir, 'verilator'), '#!/usr/bin/perl\n# 坏 perl wrapper（缺 Pod::Usage）\n')
  let wrapperError = ''
  try {
    ensureVerilatorShim(join(emptyDir, 'verilator'))
  } catch (error) {
    wrapperError = error instanceof Error ? error.message : String(error)
  }
  check('wrapper 定位且同目录无 bin 时抛错', wrapperError.includes('verilator_bin.exe') && wrapperError.includes('禁止静默回退'))
  check('抛错信息点名坏 wrapper', wrapperError.includes('perl wrapper') || wrapperError.includes('Pod::Usage'), wrapperError.slice(0, 80))

  let missingError = ''
  try {
    ensureVerilatorShim(join(emptyDir, 'verilator_bin.exe'))
  } catch (error) {
    missingError = error instanceof Error ? error.message : String(error)
  }
  check('直接给不存在的 verilator_bin.exe 也抛错', missingError.includes('不存在'))
}

// ============ 用例 3：功能性——本机真实 verilator 经 shim 可用（无 verilator 则跳过） ============
{
  const located = await locateTool(VERILATOR_CANDIDATES)
  if (!located) {
    console.log('    [功能] 本机未找到 verilator，跳过真实 shim 验证')
  } else {
    const shim = ensureVerilatorShim(located)
    const which = execFileSync(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-c', 'import os, shutil; print(shutil.which("verilator"))'],
      { env: { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH ?? ''}` }, encoding: 'utf-8' }
    ).trim()
    check('shim 前置 PATH 后 shutil.which("verilator") 命中 shim',
      which.toLowerCase() === shim.cmdPath.toLowerCase(), `${which} vs ${shim.cmdPath}`)
    const version = await run(shim.cmdPath, ['--version'], { ...process.env, PATH: `${shim.dir}${delimiter}${process.env.PATH ?? ''}` }, undefined, undefined, 30_000)
    check('经 shim 执行 verilator --version 输出真实版本（perl wrapper 故障被绕过）',
      version.code === 0 && /Verilator/.test(version.stdout), version.stdout.trim().split(/\r?\n/)[0])
    check('经 shim 执行不再出现 Pod::Usage 故障', !version.stdout.includes('Pod/Usage') && !version.stderr.includes('Pod/Usage'))
  }
}

// 收尾：删除沙箱；共享 shim 目录留给生产按需重建（内容指纹自动纠偏）
rmSync(sandbox, { recursive: true, force: true })

if (failures === 0) {
  console.log('\n✅ verilator shim 冒烟通过')
} else {
  console.log(`\n❌ ${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
