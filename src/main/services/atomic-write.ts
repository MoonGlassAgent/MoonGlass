/**
 * Windows 原子写重试助手。
 *
 * 杀毒软件实时扫描会瞬时持有新建的临时文件/目标文件，rename 偶发 EPERM/EBUSY
 * （测试套件与打包流程的高频命中点；扫描释放通常 <1s）。仅对这两类瞬时错误做
 * 短退避重试，其余错误原样抛出。同步上下文用 Atomics.wait 实现毫秒级睡眠。
 */

import { renameSync } from 'node:fs'

/** renameSync 的 EPERM/EBUSY 退避重试版（默认 5 次，100/200/300/400/500ms）。 */
export function renameSyncWithRetry(from: string, to: string, attempts = 5): void {
  const sleepMs = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'EPERM' && code !== 'EBUSY') throw error
      lastError = error
      sleepMs(100 * (attempt + 1))
    }
  }
  throw lastError
}
