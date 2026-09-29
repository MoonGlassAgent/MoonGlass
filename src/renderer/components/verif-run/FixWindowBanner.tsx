/**
 * 修复窗口横幅（方案 C 批 2，设计文档 §4.1）。
 *
 * rtl-fix-in-progress.json 存在时工作区全局置顶一条琥珀色横幅：
 * "RTL 修复进行中（根因 RC-x / 场景 SCN-y），修复窗口内 rtl/ 目录处于写保护状态。"
 * 窗口结束（标志文件消失）后由集成方传入 null 自动消失；审计落盘后在修复卡可见窗口结果。
 */

import { Lock } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { formatVerifTimestamp, type RtlFixInProgressView } from './types'

export interface FixWindowBannerProps {
  /** 修复窗口标志（rtl-fix-in-progress.json 归一化结果；null=无修复窗口，不渲染） */
  fix: RtlFixInProgressView | null
}

export function FixWindowBanner({ fix }: FixWindowBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!fix) return null
  const text = t('verifRun.window.banner', { rootCauseId: fix.rootCauseId, scenarioId: fix.scenarioId })
  return <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800" role="status">
    <Lock size={13} className="shrink-0 animate-pulse text-amber-600" />
    <span className="min-w-0 flex-1 truncate" title={text}>{text}</span>
    {fix.startedAt && <span className="shrink-0 text-[10px] text-amber-600">{t('verifRun.window.since', { time: formatVerifTimestamp(fix.startedAt) })}</span>}
  </div>
}
