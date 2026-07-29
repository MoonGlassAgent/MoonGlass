/**
 * Python 脚本引擎（骨架：最小可用）
 *
 * 通过 child_process.spawn 启动独立 Python 进程执行代码片段，
 * 带超时控制，捕获 stdout/stderr。
 * TODO(Phase 2): 升级为 Jupyter Kernel（ipykernel）模式，支持变量持久化；
 * TODO(Phase 2): 每项目独立 venv 与 requirements.txt 管理。
 */

import { spawn } from 'node:child_process'
import type { PythonRunRequest, PythonRunResult } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'

const DEFAULT_TIMEOUT_MS = 60_000

export class PythonService implements MoonGlassService {
  readonly name = 'python-service'

  start(): void {
    // 骨架阶段无常驻进程
  }

  stop(): void {
    // 骨架阶段无常驻进程
  }

  run(req: PythonRunRequest): Promise<PythonRunResult> {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const startedAt = Date.now()

    return new Promise((resolve) => {
      const child = spawn('python', ['-c', req.code], {
        cwd: req.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)

      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr: stderr + `\n[python-service] spawn 失败: ${err.message}`,
          exitCode: null,
          timedOut,
          durationMs: Date.now() - startedAt
        })
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          durationMs: Date.now() - startedAt
        })
      })
    })
  }
}
