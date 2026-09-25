import { useCallback, useMemo } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function MarkdownPreview({ content }: { content: string }): React.JSX.Element {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false }) as string), [content])

  // 链接点击拦截：报告里的相对路径链接默认会触发整窗导航，
  // file:// 下直接渲染进程白屏，这里统一改走工作区 openFile 链路
  // （文件不存在时由 WorkspacePage 兜底展示）。http(s) 链接放行，
  // 交给主进程 will-navigate 兜底 openExternal；纯 #anchor 保持页内默认行为。
  const handleClick = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || /^https?:/i.test(href) || href.startsWith('#')) return
    event.preventDefault()
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return
    try {
      const path = decodeURI(href.split('#')[0] ?? '')
      if (path) window.dispatchEvent(new CustomEvent('moonglass-open-project-file', { detail: { path } }))
    } catch {
      // href 含非法转义序列时 decodeURI 抛错，放弃本次跳转即可
    }
  }, [])

  return (
    <article
      className="markdown-preview h-full overflow-auto px-6 py-5 text-sm text-zinc-700"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
