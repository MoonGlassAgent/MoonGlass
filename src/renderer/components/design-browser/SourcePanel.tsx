import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import Prism from '../../utils/prism-setup'

const verilogGrammar = Prism.languages.verilog ?? {
  comment: [
    { pattern: /\/\*[\s\S]*?\*\//, greedy: true },
    { pattern: /\/\/.*/, greedy: true }
  ],
  string: { pattern: /"(?:\\.|[^"\\])*"/, greedy: true },
  keyword:
    /\b(?:always|always_comb|always_ff|always_latch|assign|begin|case|casex|casez|default|else|end|endcase|endfunction|endmodule|endtask|for|function|generate|if|inout|input|integer|localparam|logic|module|output|parameter|reg|signed|task|wire)\b/,
  number: /\b(?:\d+'[sS]?[bBoOdDhH][\da-fA-F_xXzZ?]+|\d+(?:\.\d+)?)\b/,
  operator: /(?:===?|!==?|&&|\|\||<<<?|>>>?|[-+*/%&|^~!]=?|[<>]=?)/,
  punctuation: /[{}[\];(),.:#@]/
}

/** 从鼠标位置提取 Verilog 标识符（单击选中 / 双击跳转共用） */
function wordAtPoint(event: React.MouseEvent): string | null {
  const doc = event.currentTarget.ownerDocument
  const range = doc.caretRangeFromPoint?.(event.clientX, event.clientY)
  if (!range) return null
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent ?? ''
  const isWordChar = (char: string): boolean => /[A-Za-z0-9_$]/.test(char)
  let start = range.startOffset
  let end = start
  while (start > 0 && isWordChar(text[start - 1])) start -= 1
  while (end < text.length && isWordChar(text[end])) end += 1
  const word = text.slice(start, end)
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(word) ? word : null
}

function baseName(file: string): string {
  const segments = file.split(/[\\/]/)
  return segments[segments.length - 1]
}

/**
 * 源码浏览器（类 Verdi nTrace 主视图）：
 * 多文件 Tab、整文件 Verilog 高亮、目标行定位、标识符单击选中 / 双击跳转。
 */
export function SourcePanel({
  tabs,
  activeFile,
  content,
  line,
  onActivate,
  onClose,
  onWord
}: {
  tabs: string[]
  activeFile: string
  content: string | null
  line: number
  onActivate: (file: string) => void
  onClose: (file: string) => void
  onWord: (word: string, action: 'select' | 'jump') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const preRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!preRef.current || !content) return
    const target = preRef.current.querySelector<HTMLElement>(`[data-source-line="${line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [activeFile, line, content])

  const handleWord = (event: React.MouseEvent, action: 'select' | 'jump'): void => {
    const word = wordAtPoint(event)
    if (word) onWord(word, action)
  }

  const lines = content?.split(/\r?\n/) ?? []

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50">
      {tabs.length > 0 && (
        <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto border-b border-zinc-300 bg-zinc-100 px-2 pt-1">
          {tabs.map((file) => (
            <span
              key={file}
              className={`group flex max-w-48 items-center gap-1 rounded-t border border-b-0 px-2 py-1 text-[11px] ${
                file === activeFile
                  ? 'border-zinc-300 bg-[#18181b] text-zinc-100'
                  : 'border-transparent bg-zinc-200/60 text-zinc-500 hover:bg-zinc-200'
              }`}
            >
              <button
                type="button"
                onClick={() => onActivate(file)}
                title={file}
                className="truncate"
              >
                {baseName(file)}
              </button>
              <button
                type="button"
                onClick={() => onClose(file)}
                aria-label={t('designBrowser.source.closeTab', { name: baseName(file) })}
                className={`rounded p-0.5 hover:bg-zinc-400/40 ${
                  file === activeFile ? 'text-zinc-400' : 'invisible text-zinc-400 group-hover:visible'
                }`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {content !== null ? (
        <pre
          ref={preRef}
          onClick={(event) => handleWord(event, 'select')}
          onDoubleClick={(event) => handleWord(event, 'jump')}
          className="rtl-source min-h-0 flex-1 cursor-text overflow-auto overscroll-contain bg-[#18181b] py-2 text-[11px] leading-5"
        >
          {lines.map((text, index) => {
            const lineNumber = index + 1
            return (
              <div
                key={lineNumber}
                data-source-line={lineNumber}
                className={`min-w-max border-l-2 px-2 ${
                  lineNumber === line
                    ? 'border-sky-400 bg-sky-950/50'
                    : 'border-transparent hover:bg-zinc-800/60'
                }`}
              >
                <span className="mr-4 inline-block w-8 select-none text-right text-zinc-600">
                  {lineNumber}
                </span>
                <code
                  className="language-verilog"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{
                    __html: text ? Prism.highlight(text, verilogGrammar, 'verilog') : ' '
                  }}
                />
              </div>
            )
          })}
        </pre>
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-zinc-400">
          {t('designBrowser.source.emptyHint')}
        </div>
      )}
    </div>
  )
}
