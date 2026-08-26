import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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
for (const name of ['libgcc_s_seh-1.dll', 'libwinpthread-1.dll', 'libstdc++-6.dll', 'libffi-8.dll', 'libreadline8.dll', 'libhistory8.dll', 'libtermcap-0.dll', 'libintl-8.dll', 'libiconv-2.dll', 'tcl86.dll', 'zlib1.dll']) {
  const canonical = existsSync(join(source, 'lib', name)) ? name : name === 'libiconv-2.dll' ? 'iconv.dll' : name
  copy(join('lib', canonical))
}
copy(join('share', 'yosys'))
copy(join('lib', 'python3.11', 'site-packages', 'click'))
for (const name of ['LICENSE.yosys', 'LICENSE.sby', 'LICENSE.boolector', 'LICENSE.bitwuzla']) copy(join('license', name))
writeFileSync(join(runtime, 'bin', 'sby.cmd'), '@echo off\r\nset "PYTHONPATH=%~dp0..\\share\\yosys\\python3;%~dp0..\\lib\\python3.11\\site-packages"\r\npython "%~dp0sby-script.py" %*\r\n', 'ascii')
writeFileSync(join(runtime, 'bin', 'yosys-smtbmc.cmd'), '@echo off\r\nset "PYTHONPATH=%~dp0..\\share\\yosys\\python3;%~dp0..\\lib\\python3.11\\site-packages"\r\npython "%~dp0yosys-smtbmc.exe-script.py" %*\r\n', 'ascii')
writeFileSync(join(runtime, 'manifest.json'), JSON.stringify({ id: 'moonglass-aigv-runtime', version: 1, platform: 'win32', arch: 'x64', tools: ['Slang', 'Yosys', 'SymbiYosys', 'Yosys-SMTBMC', 'Boolector', 'Bitwuzla'], source: 'OSS CAD Suite', generatedAt: new Date().toISOString() }, null, 2), 'utf-8')
rmSync(archive, { force: true })
execFileSync('tar', ['-czf', archive, '-C', stageRoot, 'aigv-toolchain'], { stdio: 'inherit' })
console.log(`[aigv-runtime] ${archive}`)
