/**
 * 术语悬浮解释（GlossaryTip）
 *
 * 虚线下划线标记 + 原生 title 一句话解释，用于波段、Intent、主行动等
 * 方法学术语在界面首次出现处的兜底说明（不做新手/专家模式开关）。
 * 术语解释文案统一走 i18n verification.glossary 节。
 */

export function GlossaryTip({ tip, children, className }: { tip: string; children: React.ReactNode; className?: string }): React.JSX.Element {
  return <span title={tip} className={`cursor-help border-b border-dashed border-zinc-400 ${className ?? ''}`}>{children}</span>
}
