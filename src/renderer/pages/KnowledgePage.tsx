/**
 * 知识库页（占位）
 *
 * TODO: 接入 sqlite-vec 本地向量检索 + 文档分块导入
 * （Verilog / Markdown / PDF / Word / Excel / Wavedrom JSON）
 */

import { useTranslation } from '../i18n'

export function KnowledgePage(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <div className="text-4xl">▤</div>
      <h1 className="text-lg font-medium text-zinc-700">{t('knowledge.title')}</h1>
      <p className="max-w-md text-center text-sm">
        {t('knowledge.description')}
      </p>
    </div>
  )
}
