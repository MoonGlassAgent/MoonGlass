import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter } from 'node:path'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { locateTool, run, toolEnv } from './tool-runner.ts'

export type FormalMode = 'bmc' | 'prove' | 'cover'
export interface FormalRunOptions { workspaceDir: string; top: string; rtlFiles: string[]; propertyFiles: string[]; mode?: FormalMode; depth?: number; engine?: 'boolector' | 'bitwuzla' | 'z3'; taskName?: string; scenarioId?: string; signal?: AbortSignal }
export interface FormalRunResult { passed: boolean; status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR'; mode: FormalMode; top: string; engine: string; depth: number; scenarioId?: string; configPath: string; resultDir: string; logPath: string; traces: string[]; propertyFiles: string[]; message: string }

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'formal' }
function collect(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return []
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...collect(path, match))
    else if (match.test(entry.name) && statSync(path).size > 0) result.push(path)
  }
  return result
}

export async function runFormalVerification(options: FormalRunOptions): Promise<FormalRunResult> {
  const workspace = resolve(options.workspaceDir)
  const sby = await locateTool(process.platform === 'win32' ? ['sby.exe', 'sby.cmd', 'sby'] : ['sby'])
  if (!sby) throw new Error('未找到 SymbiYosys (sby)。请在“设置 > 开发环境与 EDA 工具链”安装 OSS CAD Suite。')
  const mode = options.mode ?? 'bmc'; const depth = Math.max(1, Math.min(10000, Math.round(options.depth ?? (mode === 'prove' ? 40 : 64))))
  const engine = options.engine ?? 'boolector'; const task = safeName(options.taskName ?? `${options.top}_${mode}`)
  const root = join(workspace, 'verification', 'formal'); const resultDir = join(root, 'results', task); mkdirSync(resultDir, { recursive: true })
  const allFiles = [...new Set([...options.rtlFiles, ...options.propertyFiles].map((file) => resolve(workspace, file)))]
  const missing = allFiles.filter((file) => !existsSync(file)); if (missing.length) throw new Error(`Formal 输入文件不存在：${missing.join(', ')}`)
  const names = new Map<string, string>();
  for (const file of allFiles) { const name = basename(file); if (names.has(name) && names.get(name) !== file) throw new Error(`Formal 输入存在同名文件：${name}`); names.set(name, file) }
  const configPath = join(root, `${task}.sby`)
  const files = [...names.entries()]
  writeFileSync(configPath, `[options]\nmode ${mode}\ndepth ${depth}\nwait on\n\n[engines]\nsmtbmc ${engine}\n\n[script]\nread -formal -sv ${files.map(([name]) => name).join(' ')}\nprep -top ${options.top}\n\n[files]\n${files.map(([name, file]) => `${name} ${file.replace(/\\/g, '/')}`).join('\n')}\n`, 'utf-8')
  const env = toolEnv(sby)
  if (process.platform === 'win32') {
    const packagedSmtbmc = join(dirname(sby), 'yosys-smtbmc.exe.exe')
    if (existsSync(packagedSmtbmc)) {
      const shimDir = join(root, '.moonglass-bin'); mkdirSync(shimDir, { recursive: true })
      writeFileSync(join(shimDir, 'yosys-smtbmc.cmd'), `@echo off\r\n"${packagedSmtbmc}" %*\r\n`, 'utf-8')
      env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`
    }
  }
  const execution = await run(sby, ['-f', '-d', resultDir, configPath], env, options.signal, workspace, 15 * 60_000)
  const combined = `${execution.stdout}\n${execution.stderr}`; const logPath = join(resultDir, 'moonglass-formal.log'); writeFileSync(logPath, combined, 'utf-8')
  const statusText = collect(resultDir, /^status$/i).map((file) => readFileSync(file, 'utf-8')).join('\n')
  const token = /\b(PASS|FAIL|UNKNOWN|ERROR)\b/i.exec(`${statusText}\n${combined}`)?.[1]?.toUpperCase() as FormalRunResult['status'] | undefined
  const status = token ?? (execution.code === 0 ? 'UNKNOWN' : 'ERROR'); const traces = collect(resultDir, /\.(?:vcd|fst|yw)$/i).map((file) => relative(workspace, file))
  const result: FormalRunResult = { passed: status === 'PASS', status, mode, top: options.top, engine, depth, scenarioId: options.scenarioId, configPath: relative(workspace, configPath), resultDir: relative(workspace, resultDir), logPath: relative(workspace, logPath), traces, propertyFiles: options.propertyFiles, message: status === 'PASS' ? `${mode} 任务通过` : status === 'FAIL' ? `发现反例或属性失败${traces.length ? '，已生成 trace' : ''}` : `Formal 任务状态 ${status}，请检查日志` }
  writeFileSync(join(resultDir, 'formal-result.json'), JSON.stringify({ ...result, generatedAt: new Date().toISOString(), exitCode: execution.code }, null, 2), 'utf-8')
  return result
}
