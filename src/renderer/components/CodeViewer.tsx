import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { loader, type Monaco } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'

loader.config({ monaco })

self.MonacoEnvironment = {
  getWorker(): Worker {
    return new editorWorker()
  }
}

let hdlLanguageRegistered = false

function registerHdlLanguage(monacoApi: Monaco): void {
  if (hdlLanguageRegistered) return
  hdlLanguageRegistered = true
  monacoApi.languages.register({ id: 'systemverilog', extensions: ['.v', '.vh', '.sv', '.svh'] })
  monacoApi.languages.setMonarchTokensProvider('systemverilog', {
    keywords: [
      'always', 'always_comb', 'always_ff', 'always_latch', 'assign', 'begin', 'case', 'casex',
      'casez', 'default', 'else', 'end', 'endcase', 'endfunction', 'endgenerate', 'endmodule',
      'endpackage', 'endtask', 'for', 'function', 'generate', 'genvar', 'if', 'initial', 'input',
      'inout', 'integer', 'interface', 'logic', 'localparam', 'module', 'output', 'package',
      'parameter', 'reg', 'signed', 'task', 'typedef', 'unsigned', 'wire'
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/[a-zA-Z_$][\w$]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+/, 'number'],
        [/\b\d+(?:\.\d+)?\b/, 'number'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@string'],
        [/[{}()[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter']
      ],
      comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
      string: [[/[^\\"]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string', '@pop']]
    }
  })
}

export function fileLanguage(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const ext = name.split('.').pop() ?? ''
  if (/^(log|out|rpt)$/.test(ext) || name.includes('log')) return 'plaintext'
  const map: Record<string, string> = {
    v: 'systemverilog', vh: 'systemverilog', sv: 'systemverilog', svh: 'systemverilog',
    c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp', py: 'python', pl: 'perl', pm: 'perl',
    tcl: 'tcl', sdc: 'tcl', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown', xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
    bat: 'bat', cmd: 'bat', ini: 'ini', cfg: 'ini', makefile: 'plaintext', mk: 'plaintext'
  }
  return name === 'makefile' ? 'plaintext' : map[ext] ?? 'plaintext'
}

interface CodeViewerProps {
  path: string
  content: string
  line?: number
  column?: number
  revealKey?: number
  findRequestKey?: number
  wordWrap?: boolean
  fontSize?: number
}

export function CodeViewer({ path, content, line, column, revealKey, findRequestKey = 0, wordWrap = false, fontSize = 13 }: CodeViewerProps): React.JSX.Element {
  const [theme, setTheme] = useState<'vs' | 'vs-dark'>(() =>
    document.documentElement.dataset.colorMode === 'dark' ? 'vs-dark' : 'vs'
  )
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const [findCount, setFindCount] = useState(0)
  const language = useMemo(() => fileLanguage(path), [path])

  const find = (direction: 1 | -1, query = findQuery): void => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !query) {
      setFindCount(0)
      setFindIndex(-1)
      return
    }
    const matches = model.findMatches(query, false, false, false, null, true)
    setFindCount(matches.length)
    if (matches.length === 0) {
      setFindIndex(-1)
      return
    }
    const next = direction > 0
      ? (findIndex + 1 + matches.length) % matches.length
      : (findIndex - 1 + matches.length) % matches.length
    setFindIndex(next)
    editor.setSelection(matches[next].range)
    editor.revealRangeInCenter(matches[next].range)
  }

  useEffect(() => {
    const sync = (): void => setTheme(document.documentElement.dataset.colorMode === 'dark' ? 'vs-dark' : 'vs')
    window.addEventListener('moonglass-color-mode-change', sync)
    window.addEventListener('moonglass-system-color-change', sync)
    return () => {
      window.removeEventListener('moonglass-color-mode-change', sync)
      window.removeEventListener('moonglass-system-color-change', sync)
    }
  }, [])

  useEffect(() => {
    if (!line || !editorRef.current) return
    editorRef.current.revealLineInCenter(line)
    editorRef.current.setPosition({ lineNumber: line, column: column ?? 1 })
    editorRef.current.focus()
  }, [line, column, path, revealKey])

  useEffect(() => {
    if (!findRequestKey || !editorRef.current) return
    setFindOpen(true)
    window.setTimeout(() => findInputRef.current?.focus(), 0)
  }, [findRequestKey])

  return (
    <div className="relative h-full">
      {findOpen && (
        <div className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded border border-zinc-300 bg-white p-1 shadow-md">
          <input
            ref={findInputRef}
            value={findQuery}
            onChange={(event) => {
              const query = event.target.value
              setFindQuery(query)
              setFindIndex(-1)
              window.setTimeout(() => find(1, query), 0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey ? -1 : 1)
              if (event.key === 'Escape') setFindOpen(false)
            }}
            className="h-6 w-56 rounded border border-zinc-300 px-2 text-xs text-zinc-800 outline-none focus:border-blue-400"
            placeholder="查找文件内容"
            aria-label="查找内容"
          />
          <span className="min-w-12 text-center text-[10px] text-zinc-400">{findCount ? `${findIndex + 1}/${findCount}` : '无结果'}</span>
          <button onClick={() => find(-1)} className="h-6 w-6 rounded text-xs text-zinc-600 hover:bg-zinc-100" title="上一个">↑</button>
          <button onClick={() => find(1)} className="h-6 w-6 rounded text-xs text-zinc-600 hover:bg-zinc-100" title="下一个">↓</button>
          <button onClick={() => setFindOpen(false)} className="h-6 w-6 rounded text-xs text-zinc-600 hover:bg-zinc-100" title="关闭">×</button>
        </div>
      )}
      <Editor
        path={path}
        value={content}
        language={language}
        theme={theme}
        beforeMount={registerHdlLanguage}
        onMount={(editor) => {
          editorRef.current = editor
          if (line) {
            editor.revealLineInCenter(line)
            editor.setPosition({ lineNumber: line, column: column ?? 1 })
          }
          if (findRequestKey) {
            setFindOpen(true)
            window.setTimeout(() => findInputRef.current?.focus(), 0)
          }
        }}
        loading={<div className="flex h-full items-center justify-center text-xs text-zinc-400">正在加载代码查看器...</div>}
        options={{
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          renderLineHighlight: 'all',
          folding: true,
          foldingHighlight: true,
          stickyScroll: { enabled: true },
          minimap: { enabled: false },
          glyphMargin: false,
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          wordWrap: wordWrap ? 'on' : 'off',
          fontSize,
          lineHeight: Math.round(fontSize * 1.55),
          fontFamily: "Consolas, 'Cascadia Code', monospace",
          largeFileOptimizations: true,
          links: true,
          contextmenu: true,
          padding: { top: 8, bottom: 8 }
        }}
      />
    </div>
  )
}
