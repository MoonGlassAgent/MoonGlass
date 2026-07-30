/**
 * 设置页
 *
 * - 模型服务：LLM Provider 配置管理（API Key / Base URL / 模型列表），
 *   预置 8 家 + 自定义新增，配置经 IPC 持久化到主进程 JSON 存储。
 * - EDA 工具链探测：扫描系统 PATH（真实可用）。
 * 后续：工具链路径配置、公司规则管理、外观设置。
 */

import { useEffect, useState } from 'react'
import type { LlmProviderConfig, ToolDetection } from '@shared/types'

export function SettingsPage(): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-6 text-xl font-bold text-zinc-900">设置</h1>
      <LlmProviderSection />
      <EdaDetectSection />
      <section className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
        <h2 className="mb-1 font-semibold text-zinc-600">更多设置（占位）</h2>
        工具链路径配置（resources/moonglass/toolchains.json）· 公司编码规则管理 · 外观设置
      </section>
    </div>
  )
}

// ==================== 模型服务 ====================

function LlmProviderSection(): React.JSX.Element {
  const [providers, setProviders] = useState<LlmProviderConfig[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<LlmProviderConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedTip, setSavedTip] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void window.moonglass.llm.list().then((list) => {
      setProviders(list)
      if (list.length > 0) {
        setSelectedId(list[0].id)
        setDraft({ ...list[0], models: [...list[0].models] })
      }
    })
  }, [])

  const select = (p: LlmProviderConfig): void => {
    setSelectedId(p.id)
    setDraft({ ...p, models: [...p.models] })
    setSavedTip('')
    setTestResult(null)
    setShowKey(false)
    setNewModel('')
  }

  const testProvider = async (): Promise<void> => {
    if (!draft) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.moonglass.llm.test(draft.id)
      if (result.ok) {
        setTestResult({ ok: true, message: `连接成功（HTTP ${result.status ?? 200}）` })
      } else {
        setTestResult({
          ok: false,
          message: result.status
            ? `连接失败：${result.error ?? `HTTP ${result.status}`}`
            : `连接失败：${result.error ?? '未知错误'}`
        })
      }
    } catch (err) {
      setTestResult({ ok: false, message: `测试异常：${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setTesting(false)
    }
  }

  const patch = (partial: Partial<LlmProviderConfig>): void => {
    setDraft((d) => (d ? { ...d, ...partial } : d))
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = await window.moonglass.llm.upsert(draft)
      const list = await window.moonglass.llm.list()
      setProviders(list)
      setDraft({ ...saved, models: [...saved.models] })
      setSavedTip('已保存')
      setTimeout(() => setSavedTip(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  const addCustom = async (): Promise<void> => {
    const created = await window.moonglass.llm.upsert({
      id: crypto.randomUUID(),
      name: '自定义 Provider',
      protocol: 'openai-compatible',
      baseUrl: '',
      apiKey: '',
      models: [],
      enabled: false,
      builtin: false
    })
    const list = await window.moonglass.llm.list()
    setProviders(list)
    select(created)
  }

  const remove = async (): Promise<void> => {
    if (!draft || draft.builtin) return
    const ok = await window.moonglass.llm.delete(draft.id)
    if (!ok) return
    const list = await window.moonglass.llm.list()
    setProviders(list)
    if (list.length > 0) select(list[0])
    else {
      setSelectedId(null)
      setDraft(null)
    }
  }

  const addModel = (): void => {
    const name = newModel.trim()
    if (!name || !draft || draft.models.includes(name)) return
    patch({ models: [...draft.models, name] })
    setNewModel('')
  }

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-800">模型服务</h2>
        <p className="mt-1 text-sm text-zinc-500">
          配置大模型 Provider 的 API Key / Base URL / 模型列表（配置保存在本地，对话功能 Phase 2 接入）
        </p>
      </div>

      {!providers ? (
        <p className="text-sm text-zinc-500">加载中…</p>
      ) : (
        <div className="flex gap-4">
          {/* Provider 列表 */}
          <div className="w-52 shrink-0">
            <ul className="space-y-1">
              {providers.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => select(p)}
                    className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm ${
                      p.id === selectedId
                        ? 'bg-zinc-100 text-zinc-900'
                        : 'text-zinc-600 hover:bg-zinc-200/50'
                    }`}
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="ml-2 flex items-center gap-1.5">
                      {!p.apiKey && (
                        <span className="size-1.5 rounded-full bg-zinc-400" aria-label="未配置 Key" />
                      )}
                      {p.enabled && <span className="size-1.5 rounded-full bg-emerald-500" />}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              onClick={() => void addCustom()}
              className="mt-2 w-full rounded border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-500 hover:border-zinc-400 hover:text-zinc-700"
            >
              + 添加自定义 Provider
            </button>
          </div>

          {/* 编辑表单 */}
          {draft && (
            <div className="min-w-0 flex-1 space-y-4 border-l border-zinc-200 pl-4">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                    className="accent-blue-600"
                  />
                  启用该 Provider
                </label>
                <span className="text-xs text-zinc-500">
                  协议：{draft.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容'}
                </span>
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">名称</label>
                <input
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  disabled={draft.builtin}
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 disabled:opacity-50"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">Base URL</label>
                <input
                  value={draft.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  placeholder="https://…"
                  className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-800"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">API Key</label>
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={draft.apiKey}
                    onChange={(e) => patch({ apiKey: e.target.value })}
                    placeholder="sk-…"
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-800"
                  />
                  <button
                    onClick={() => setShowKey((v) => !v)}
                    className="shrink-0 rounded border border-zinc-300 px-3 text-xs text-zinc-600 hover:text-zinc-800"
                  >
                    {showKey ? '隐藏' : '显示'}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">模型列表</label>
                <div className="mb-2 flex flex-wrap gap-2">
                  {draft.models.map((m) => (
                    <span
                      key={m}
                      className="flex items-center gap-1 rounded bg-zinc-100 px-2 py-1 font-mono text-xs text-zinc-700"
                    >
                      {m}
                      <button
                        onClick={() => patch({ models: draft.models.filter((x) => x !== m) })}
                        className="text-zinc-400 hover:text-red-600"
                        aria-label={`移除模型 ${m}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {draft.models.length === 0 && (
                    <span className="text-xs text-zinc-400">暂无模型，请添加</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addModel()}
                    placeholder="输入模型 ID，回车添加"
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-800"
                  />
                  <button
                    onClick={addModel}
                    className="shrink-0 rounded border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    添加
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? '保存中…' : '保存'}
                </button>
                <button
                  onClick={() => void testProvider()}
                  disabled={testing || !draft.apiKey}
                  className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  {testing ? '测试中…' : '测试连接'}
                </button>
                {!draft.builtin && (
                  <button
                    onClick={() => void remove()}
                    className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    删除
                  </button>
                )}
                {savedTip && <span className="text-sm text-emerald-600">{savedTip}</span>}
                {testResult && (
                  <span
                    className={`text-sm ${testResult.ok ? 'text-emerald-600' : 'text-red-600'}`}
                  >
                    {testResult.message}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

// ==================== EDA 工具链探测 ====================

function EdaDetectSection(): React.JSX.Element {
  const [tools, setTools] = useState<ToolDetection[] | null>(null)
  const [detecting, setDetecting] = useState(false)

  const detect = async (): Promise<void> => {
    setDetecting(true)
    try {
      setTools(await window.moonglass.eda.detectTools())
    } finally {
      setDetecting(false)
    }
  }

  return (
    <section className="mb-8 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-zinc-800">EDA 工具链探测</h2>
          <p className="mt-1 text-sm text-zinc-500">
            扫描系统 PATH 中的 EDA 工具（@moonglass/eda-bridge）
          </p>
        </div>
        <button
          onClick={() => void detect()}
          disabled={detecting}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {detecting ? '探测中…' : '开始探测'}
        </button>
      </div>

      {tools && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-left text-zinc-500">
              <th className="py-2 pr-4 font-medium">工具</th>
              <th className="py-2 pr-4 font-medium">状态</th>
              <th className="py-2 pr-4 font-medium">路径</th>
              <th className="py-2 font-medium">版本</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t) => (
              <tr key={t.tool} className="border-b border-zinc-200/60">
                <td className="py-2 pr-4 font-mono text-zinc-700">{t.tool}</td>
                <td className="py-2 pr-4">
                  {t.found ? (
                    <span className="text-emerald-600">✓ 已安装</span>
                  ) : (
                    <span className="text-zinc-400">未找到</span>
                  )}
                </td>
                <td className="max-w-64 truncate py-2 pr-4 font-mono text-xs text-zinc-500">
                  {t.path ?? '—'}
                </td>
                <td className="py-2 text-xs text-zinc-500">{t.version ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
