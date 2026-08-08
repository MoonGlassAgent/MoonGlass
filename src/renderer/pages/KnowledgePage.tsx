/**
 * 知识库页（占位）
 *
 * TODO: 接入 sqlite-vec 本地向量检索 + 文档分块导入
 * （Verilog / Markdown / PDF / Word / Excel / Wavedrom JSON）
 */

export function KnowledgePage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-zinc-500">
      <div className="text-4xl">▤</div>
      <h1 className="text-lg font-medium text-zinc-700">知识库</h1>
      <p className="max-w-md text-center text-sm">
        待接入 sqlite-vec 本地向量检索：项目文档、规格书、IP 代码与历史评审记录的语义检索，
        对话时自动注入相关上下文（RAG）。
      </p>
    </div>
  )
}
