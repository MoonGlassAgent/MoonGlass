/**
 * verification/ 目录变更订阅 Hook。
 *
 * 挂载期间开始监视项目 verification/（引用计数），引擎产物/证据 JSON 变化时
 * 回调 onChanged（主进程已做 ~800ms 去抖与 .json 过滤）；卸载时退订。
 * 用于验证态势页、VerifStatusBar、验证运行面板等的自动刷新。
 */

import { useEffect, useRef } from 'react'

export function useVerificationChanged(projectId: string | undefined, onChanged: () => void): void {
  const cbRef = useRef(onChanged)
  cbRef.current = onChanged

  useEffect(() => {
    if (!projectId) return
    void window.moonglass.fs.watchVerification(projectId)
    const off = window.moonglass.fs.onVerificationChanged((payload) => {
      if (payload.projectId === projectId) cbRef.current()
    })
    return () => {
      off()
      void window.moonglass.fs.unwatchVerification(projectId)
    }
  }, [projectId])
}
