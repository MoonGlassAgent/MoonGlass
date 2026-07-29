/**
 * Python 脚本管理页（骨架）
 *
 * 骨架阶段提供最小可用的代码执行验证（经 PythonService IPC），
 * 后续升级为类 Jupyter Notebook 的 Cell 交互 + 项目级脚本库管理。
 */

import { useState } from 'react'

const SCRIPT_TEMPLATES = [
  { id: 'rtl-batch', name: 'RTL 批量生成', desc: '基于参数化配置批量生成 RTL 模块' },
  { id: 'reg-table', name: '寄存器表生成', desc: '由规格表生成寄存器 RTL 与文档' },
  { id: 'wave-analysis', name: '波形分析', desc: '解析 VCD 波形并统计信号翻转' },
  { id: 'coverage-parse', name: '覆盖率解析', desc: '解析覆盖率报告生成摘要' },
  { id: 'sdc-gen', name: 'SDC 生成', desc: '由时钟规格生成 SDC 约束文件' }
] as const

export function ScriptsPage(): React.JSX.Element {
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
      <h1 className="mb-1 text-xl font-bold text-zinc-900">Python 脚本</h1>
      <p className="mb-6 text-sm text-zinc-500">
        脚本模板库占位（Phase 2 升级为 Notebook Cell 交互 + 项目级 venv）
      </p>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {SCRIPT_TEMPLATES.map((t) => (
          <div key={t.id} className="rounded-lg border border-zinc-200 bg-white p-3">
            <div className="text-sm font-medium text-zinc-800">{t.name}</div>
            <div className="mt-1 text-xs text-zinc-500">{t.desc}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-zinc-700">快速执行（冒烟验证）</span>
          <button
            onClick={() => void run()}
            disabled={running}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {running ? '运行中…' : '▶ 运行'}
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
