import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function MarkdownPreview({ content }: { content: string }): React.JSX.Element {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false }) as string), [content])
  return (
    <article
      className="markdown-preview h-full overflow-auto px-6 py-5 text-sm text-zinc-700"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
