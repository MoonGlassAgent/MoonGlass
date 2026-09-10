import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const source = resolve(process.env.MOONGLASS_OSS_CAD_ROOT ?? join(process.env.USERPROFILE ?? '', 'oss-cad-suite', 'oss-cad-suite'))
if (!existsSync(join(source, 'bin', 'yosys.exe'))) throw new Error(`未找到 OSS CAD Suite：${source}。请设置 MOONGLASS_OSS_CAD_ROOT。`)
const stageRoot = join(repo, 'build-resources', 'bundled-aigv-runtime')
const runtime = join(stageRoot, 'aigv-toolchain')
const outputDir = join(repo, 'resources', 'moonglass', 'bundled-toolchains', 'windows-x64')
const archive = join(outputDir, 'moonglass-aigv-runtime.tgz')
rmSync(stageRoot, { recursive: true, force: true }); mkdirSync(join(runtime, 'bin'), { recursive: true }); mkdirSync(join(runtime, 'license'), { recursive: true }); mkdirSync(outputDir, { recursive: true })

const copy = (relative) => { const from = join(source, relative); if (!existsSync(from)) throw new Error(`AIGV Runtime 缺少源文件：${from}`); const to = join(runtime, relative); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to, { recursive: true }) }
for (const name of ['slang.exe', 'yosys.exe', 'boolector.exe', 'bitwuzla.exe', 'sby-script.py', 'yosys-smtbmc.exe-script.py']) copy(join('bin', name))
// Python 解释器：sby / yosys-smtbmc 是 Python 脚本，目标机器可能没有任何系统 Python，
// 必须把 OSS CAD Suite 自带解释器打进运行时，wrapper 直接调用它而不是裸 `python`
for (const name of ['python3.11.exe', 'libpython3.11.dll']) copy(join('lib', name))
// MinGW/Tcl 运行时 DLL + Python 扩展模块（lib-dynload 的 .pyd）依赖库
for (const name of ['libgcc_s_seh-1.dll', 'libwinpthread-1.dll', 'libstdc++-6.dll', 'libffi-8.dll', 'libreadline8.dll', 'libhistory8.dll', 'libtermcap-0.dll', 'libintl-8.dll', 'libiconv-2.dll', 'tcl86.dll', 'zlib1.dll', 'libsqlite3-0.dll', 'libbz2-1.dll', 'liblzma-5.dll', 'libexpat-1.dll', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll']) {
  const canonical = existsSync(join(source, 'lib', name)) ? name : name === 'libiconv-2.dll' ? 'iconv.dll' : name
  copy(join('lib', canonical))
}
copy(join('share', 'yosys'))
// Python 标准库（裁剪测试/GUI/__pycache__；site-packages 仅保留 sby 依赖的 click，见下行）
const PY_STDLIB_PRUNE = new Set(['__pycache__', 'test', 'tests', 'idlelib', 'turtledemo', 'tkinter', 'ensurepip', 'site-packages'])
cpSync(join(source, 'lib', 'python3.11'), join(runtime, 'lib', 'python3.11'), {
  recursive: true,
  filter: (srcPath) => !srcPath.endsWith('.pyc') && !PY_STDLIB_PRUNE.has(basename(srcPath))
})
copy(join('lib', 'python3.11', 'site-packages', 'click'))
for (const name of ['LICENSE.yosys', 'LICENSE.sby', 'LICENSE.boolector', 'LICENSE.bitwuzla']) copy(join('license', name))
// wrapper 调用运行时内置解释器（%~dp0..\lib\python3.11.exe），不再依赖系统 Python；
// PYTHONPATH 首段指向内置标准库（解释器位于 lib/，CPython 的 Lib/os.py 地标探测不到，靠 PYTHONPATH 引导）
const PY_ENV = 'set "PYTHONPATH=%~dp0..\\lib\\python3.11;%~dp0..\\share\\yosys\\python3;%~dp0..\\lib\\python3.11\\site-packages"'
writeFileSync(join(runtime, 'bin', 'sby.cmd'), `@echo off\r\n${PY_ENV}\r\n"%~dp0..\\lib\\python3.11.exe" "%~dp0sby-script.py" %*\r\n`, 'ascii')
writeFileSync(join(runtime, 'bin', 'yosys-smtbmc.cmd'), `@echo off\r\n${PY_ENV}\r\n"%~dp0..\\lib\\python3.11.exe" "%~dp0yosys-smtbmc.exe-script.py" %*\r\n`, 'ascii')
writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({ id: 'moonglass-aigv-runtime', version: 1, platform: 'win32', arch: 'x64', tools: ['Slang', 'Yosys', 'SymbiYosys', 'Yosys-SMTBMC', 'Boolector', 'Bitwuzla'], source: 'OSS CAD Suite', generatedAt: new Date().toISOString() }, null, 2), 'utf-8')
rmSync(archive, { force: true })
// Windows 上用系统自带 bsdtar：GNU tar（Git Bash 环境 PATH 优先）会把 "D:" 盘符当作远程主机语法而失败
const tarExe = process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'))
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
execFileSync(tarExe, ['-czf', archive, '-C', stageRoot, 'aigv-toolchain'], { stdio: 'inherit' })
console.log(`[aigv-runtime] ${archive}`)
