/**
 * Pi Coding Agent RPC 客户端
 *
 * 封装 `pi --mode rpc` 子进程的 JSONL 协议（stdin 命令 / stdout 响应与事件）。
 * 注意：协议要求严格 JSONL 分帧——仅按 \n 切分并剥离尾部 \r，
 * 不能用 Node readline（它会把 JSON 字符串内合法的 U+2028/U+2029 误判为换行）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export interface PiRpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

export interface PiRpcClientOptions {
  /** pi 的 dist/cli.js 绝对路径 */
  binPath: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** pi 原始事件（stdout 中非 response 的 JSON 行） */
  onEvent: (event: Record<string, unknown>) => void
  /** 进程退出（异常或正常） */
  onExit: (code: number | null, stderrTail: string) => void
}

interface PendingEntry {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface EventWaiter {
  predicate: (event: Record<string, unknown>) => boolean
  resolve: (event: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const COMMAND_TIMEOUT_MS = 30_000

export class PiRpcClient {
  private readonly options: PiRpcClientOptions
  private child: ChildProcess | null = null
  private seq = 0
  private pending = new Map<string, PendingEntry>()
  private eventWaiters = new Set<EventWaiter>()
  private buffer = ''
  private decoder = new StringDecoder('utf8')
  private stderrTail = ''

  constructor(options: PiRpcClientOptions) {
    this.options = options
  }

  start(): void {
    const { binPath, args, cwd, env } = this.options
    // 用当前 Node 启动 pi 的 JS bin，规避 Windows 上 shebang/扩展名问题
    this.child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.child.stdout!.on('data', (chunk: Buffer) => this.feed(chunk))
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000)
    })
    this.child.on('error', (err) => {
      this.failAll(new Error(`[pi-rpc] spawn 失败: ${err.message}`))
      this.options.onExit(null, this.stderrTail)
    })
    this.child.on('close', (code) => {
      this.failAll(new Error(`[pi-rpc] 进程已退出 (code=${code})`))
      this.options.onExit(code, this.stderrTail)
    })
  }

  /** 发送命令并等待对应 id 的响应；success=false 时 reject */
  command<T = unknown>(cmd: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('[pi-rpc] 进程未启动'))
    const id = `req-${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[pi-rpc] 命令超时: ${String(cmd.type)}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer
      })
      this.child!.stdin!.write(JSON.stringify({ id, ...cmd }) + '\n')
    })
  }

  /** 等待 pi 启动就绪（扩展加载完成后才会响应命令），轮询 get_state */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastErr: unknown
    while (Date.now() < deadline) {
      try {
        await this.command({ type: 'get_state' }, 5_000)
        return
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Error(`[pi-rpc] 等待就绪超时: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  }

  /** 等待指定 Pi 事件；用于区分“命令已接收”和“Agent 真正执行完毕”。 */
  waitForEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter)
          reject(new Error('[pi-rpc] 等待 Agent 事件超时'))
        }, timeoutMs)
      }
      this.eventWaiters.add(waiter)
    })
  }

  dispose(): void {
    const child = this.child
    this.child = null
    if (child) {
      child.stdin?.end()
      child.kill()
    }
    this.failAll(new Error('[pi-rpc] 客户端已销毁'))
  }

  private feed(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx === -1) break
      let line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim().length === 0) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      console.error('[pi-rpc] 无法解析的输出行:', line.slice(0, 200))
      return
    }
    if (msg.type === 'response') {
      const res = msg as unknown as PiRpcResponse
      const entry = res.id ? this.pending.get(res.id) : undefined
      if (entry) {
        this.pending.delete(res.id!)
        clearTimeout(entry.timer)
        if (res.success) entry.resolve(res.data)
        else entry.reject(new Error(res.error ?? `[pi-rpc] 命令失败: ${res.command}`))
      }
      return
    }
    for (const waiter of this.eventWaiters) {
      if (!waiter.predicate(msg)) continue
      this.eventWaiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    }
    this.options.onEvent(msg)
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.eventWaiters.clear()
  }
}
