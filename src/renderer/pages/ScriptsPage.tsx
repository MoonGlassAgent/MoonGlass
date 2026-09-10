/**
 * Python 脚本管理页（骨架）
 *
 * 骨架阶段提供最小可用的代码执行验证（经 PythonService IPC），
 * 后续升级为类 Jupyter Notebook 的 Cell 交互 + 项目级脚本库管理。
 */

import { useState } from 'react'
import { useTranslation, type MessageKey } from '../i18n'

const SCRIPT_TEMPLATES: ReadonlyArray<{ id: string; nameKey: MessageKey; descriptionKey: MessageKey }> = [
  { id: 'rtl-batch', nameKey: 'scripts.templates.rtlBatch.name', descriptionKey: 'scripts.templates.rtlBatch.description' },
  { id: 'reg-table', nameKey: 'scripts.templates.regTable.name', descriptionKey: 'scripts.templates.regTable.description' },
  { id: 'wave-analysis', nameKey: 'scripts.templates.waveAnalysis.name', descriptionKey: 'scripts.templates.waveAnalysis.description' },
  { id: 'coverage-parse', nameKey: 'scripts.templates.coverageParse.name', descriptionKey: 'scripts.templates.coverageParse.description' },
  { id: 'sdc-gen', nameKey: 'scripts.templates.sdcGen.name', descriptionKey: 'scripts.templates.sdcGen.description' }
]

export function ScriptsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [code, setCode] = useState("print('Hello from MoonGlass PythonService')")
  const [output, setOutput] = useState('')
  const [running, setRunning] = useState(false)

  const run = async (): Promise<void> => {
    setRunning(true)
    try {
      const r = await window.moonglass.python.run({ code })
      setOutput(
        [
          r.stdout && `stdout:\n${r.stdout}`,
          r.stderr && `stderr:\n${r.stderr}`,
          `[exit=${r.exitCode} timedOut=${r.timedOut} ${r.durationMs}ms]`
        ]
          .filter(Boolean)
          .join('\n')
      )
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <h1 className="mb-1 text-xl font-bold text-zinc-900">{t('scripts.title')}</h1>
      <p className="mb-6 text-sm text-zinc-500">
        {t('scripts.subtitle')}
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {SCRIPT_TEMPLATES.map((tpl) => (
          <div key={tpl.id} className="rounded-lg border border-zinc-200 bg-white p-3">
            <div className="text-sm font-medium text-zinc-800">{t(tpl.nameKey)}</div>
            <div className="mt-1 text-xs text-zinc-500">{t(tpl.descriptionKey)}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-700">{t('scripts.quickRun.title')}</span>
          <button
            onClick={() => void run()}
            disabled={running}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {running ? t('scripts.quickRun.running') : t('scripts.quickRun.run')}
          </button>
        </div>
        <textarea
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          className="h-28 w-full resize-y rounded border border-zinc-300 bg-white p-3 font-mono text-sm text-zinc-800 outline-none focus:border-blue-500"
        />
        {output && (
          <pre className="mt-3 max-h-56 overflow-auto rounded bg-zinc-100 p-3 text-xs text-emerald-700">
            {output}
          </pre>
        )}
      </div>
    </div>
  )
}
