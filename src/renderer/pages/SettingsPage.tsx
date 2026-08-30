/**
 * 设置页
 *
 * - 模型服务：LLM Provider 配置管理（API Key / Base URL / 模型列表），
 *   预置 8 家 + 自定义新增，配置经 IPC 持久化到主进程 JSON 存储。
 * - EDA 工具链探测：扫描系统 PATH（真实可用）。
 * 后续：工具链路径配置、公司规则管理、外观设置。
 */

import { useEffect, useState } from 'react'
import { CheckCircle2, Download, ExternalLink, RefreshCw, XCircle } from 'lucide-react'
import type {
  LlmProviderConfig,
  LlmProviderTestResult,
  ToolDetection
} from '@shared/types'
import { ThemePicker } from '../components/ThemePicker'

const notifyLlmConfigurationChanged = (): void => {
  window.dispatchEvent(new Event('moonglass:llm-config-changed'))
}

export function SettingsPage(): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-6 text-xl font-bold text-zinc-900">设置</h1>
      <AppearanceSection />
      <LlmProviderSection />
      <EdaDetectSection />
      <section className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
        <h2 className="mb-1 font-semibold text-zinc-600">更多设置（占位）</h2>
        工具链路径配置（resources/moonglass/toolchains.json）· 公司编码规则管理 · 外观设置
      </section>
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  return (
    <section className="surface-panel mb-5 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-800">外观</h2>
        <p className="mt-0.5 text-xs text-zinc-500">选择浅色、深色或跟随系统，并设置界面强调色。设置会自动保存。</p>
      </div>
      <ThemePicker />
    </section>
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
  const [testResult, setTestResult] = useState<LlmProviderTestResult | null>(null)
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
      setTestResult(await window.moonglass.llm.test(draft))
    } catch (err) {
      setTestResult({
        ok: false,
        error: `测试异常：${err instanceof Error ? err.message : String(err)}`,
        models: draft.models.map((model) => ({
          model,
          status: 'unknown',
          message: '测试异常，模型未测试'
        }))
      })
    } finally {
      setTesting(false)
    }
  }

  const patch = (partial: Partial<LlmProviderConfig>): void => {
    setDraft((d) => (d ? { ...d, ...partial } : d))
    setTestResult(null)
  }

  const setProviderEnabled = async (enabled: boolean): Promise<void> => {
    if (!draft) return
    const next = { ...draft, enabled }
    setDraft(next)
    setSaving(true)
    setSavedTip('')
    try {
      const saved = await window.moonglass.llm.upsert(next)
      setProviders((current) => current?.map((provider) => provider.id === saved.id ? saved : provider) ?? null)
      setDraft({ ...saved, models: [...saved.models] })
      setSavedTip(enabled ? '已启用' : '已停用')
      notifyLlmConfigurationChanged()
      setTimeout(() => setSavedTip(''), 1600)
    } catch (error) {
      setDraft(draft)
      setSavedTip(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = await window.moonglass.llm.upsert(draft)
      const list = await window.moonglass.llm.list()
      setProviders(list)
      setDraft({ ...saved, models: [...saved.models] })
      setSavedTip(saved.enabled ? '已保存并启用' : '已保存，但尚未启用')
      notifyLlmConfigurationChanged()
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
    notifyLlmConfigurationChanged()
    select(created)
  }

  const remove = async (): Promise<void> => {
    if (!draft || draft.builtin) return
    const ok = await window.moonglass.llm.delete(draft.id)
    if (!ok) return
    const list = await window.moonglass.llm.list()
    setProviders(list)
    notifyLlmConfigurationChanged()
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
                    onChange={(e) => void setProviderEnabled(e.target.checked)}
                    disabled={saving}
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
              </div>

              {testResult && (
                <div className="border-t border-zinc-200 pt-3">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-medium text-zinc-500">Provider 连接</span>
                    <span
                      className={`text-sm font-semibold ${
                        testResult.ok ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {testResult.ok ? 'PASS' : 'FAIL'}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {testResult.ok
                        ? testResult.availableModelCount !== undefined
                          ? `HTTP ${testResult.status ?? 200}，发现 ${testResult.availableModelCount} 个模型`
                          : `HTTP ${testResult.status ?? 200}，已逐一探测 ${testResult.models.length} 个配置模型`
                        : testResult.error ?? '未知连接错误'}
                    </span>
                  </div>

                  {testResult.endpoint && (
                    <p className="mb-3 truncate font-mono text-xs text-zinc-400" title={testResult.endpoint}>
                      {testResult.endpoint}
                    </p>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-zinc-200 text-zinc-500">
                          <th className="py-1.5 pr-3 font-medium">模型 ID</th>
                          <th className="w-24 py-1.5 pr-3 font-medium">状态</th>
                          <th className="py-1.5 font-medium">说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testResult.models.map((model) => (
                          <tr key={model.model} className="border-b border-zinc-100 last:border-0">
                            <td className="py-1.5 pr-3 font-mono text-zinc-700">{model.model}</td>
                            <td className="py-1.5 pr-3">
                              <span
                                className={
                                  model.status === 'pass'
                                    ? 'font-semibold text-emerald-700'
                                    : model.status === 'fail'
                                      ? 'font-semibold text-red-700'
                                      : 'font-medium text-amber-700'
                                }
                              >
                                {model.status === 'pass'
                                  ? 'PASS'
                                  : model.status === 'fail'
                                    ? 'FAIL'
                                    : '未测试'}
                              </span>
                            </td>
                            <td className="py-1.5 text-zinc-500">{model.message}</td>
                          </tr>
                        ))}
                        {testResult.models.length === 0 && (
                          <tr>
                            <td colSpan={3} className="py-2 text-zinc-400">
                              当前未配置模型 ID；Provider 连接结果仍然有效。
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
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
  const [detectError, setDetectError] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const [installMessage, setInstallMessage] = useState('')

  const detect = async (force = false): Promise<void> => {
    setDetecting(true)
    setDetectError('')
    try {
      const detected = await window.moonglass.eda.detectTools(force)
      setTools(detected)
      if (detected.length === 0) setDetectError('主进程未返回任何环境检测项，请重启 MoonGlass 后重试。')
    } catch (error) {
      setTools([])
      setDetectError(`环境检测失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setDetecting(false)
    }
  }

  useEffect(() => { void detect(false) }, [])

  useEffect(() => {
    if (!installing) return
    let closed = false
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        const job = await window.moonglass.eda.getInstallStatus(installing)
        if (closed) return
        setInstallMessage(job.message)
        if (job.status === 'completed' || job.status === 'failed') {
          setInstalling(null)
          await detect(true)
        }
      } catch (error) {
        if (!closed) {
          setInstallMessage(`安装状态读取失败：${error instanceof Error ? error.message : String(error)}`)
          setInstalling(null)
          await detect(true)
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 1000)
    return () => {
      closed = true
      window.clearInterval(timer)
    }
  }, [installing])

  const installBundle = async (id: string): Promise<void> => {
    const prompt = id === 'python-cocotb'
      ? '将使用当前 Python 的 pip 安装或升级 Cocotb、cocotb-bus 和 cocotb-coverage，是否继续？'
      : '将从官方 GitHub Release 下载 OSS CAD Suite。文件较大，是否继续？'
    if (!window.confirm(prompt)) return
    setInstalling(id)
    setInstallMessage(id === 'python-cocotb' ? '正在通过 pip 安装 Cocotb…' : '正在下载并解压工具包，请保持网络连接…')
    try {
      const job = await window.moonglass.eda.installBundle(id)
      setInstallMessage(job.message)
    } catch (error) {
      setInstallMessage(`启动安装失败：${error instanceof Error ? error.message : String(error)}`)
      setInstalling(null)
    }
  }

  const categories: Array<{ id: NonNullable<ToolDetection['category']>; label: string; detail: string }> = [
    { id: 'runtime', label: '基础运行环境', detail: 'Agent、技能脚本和依赖管理' },
    { id: 'build', label: '构建环境', detail: '版本管理与本地编译' },
    { id: 'eda', label: 'RTL 与综合', detail: 'Lint、仿真与逻辑综合' },
    { id: 'verification', label: '验证工具', detail: 'Cocotb、仿真器和波形查看' },
    { id: 'physical', label: '时序与物理实现', detail: 'STA 和物理感知优化' }
  ]

  const inferLegacyCategory = (tool: ToolDetection): NonNullable<ToolDetection['category']> => {
    const name = tool.tool.toLowerCase()
    if (/node|npm|pnpm|python|pip/.test(name)) return 'runtime'
    if (/git|make|gcc|clang|compiler/.test(name)) return 'build'
    if (/opensta|openroad|\bsta\b/.test(name)) return 'physical'
    if (/iverilog|cocotb|gtkwave|verible/.test(name)) return 'verification'
    return 'eda'
  }
  const normalizedTools = (tools ?? []).map((tool) => ({
    ...tool,
    category: tool.category ?? inferLegacyCategory(tool),
    importance: tool.importance ?? 'recommended' as const,
    description: tool.description ?? '由旧版主进程返回的工具检测项'
  }))

  return (
    <section className="surface-panel mb-8 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-zinc-800">开发环境与 EDA 工具链</h2>
          <p className="mt-1 text-sm text-zinc-500">
            检查 MoonGlass 完整工作流所需的运行时、构建、验证、综合与时序工具。
          </p>
        </div>
        <button
          onClick={() => void detect(true)}
          disabled={detecting}
          className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <RefreshCw size={14} className={detecting ? 'animate-spin' : ''} />
          {detecting ? '检测中…' : '重新检测'}
        </button>
      </div>

      {installMessage && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">{installMessage}</div>
      )}

      {detecting && tools === null && (
        <div className="environment-feedback">
          <RefreshCw size={15} className="animate-spin" />
          正在逐项检查环境、版本与可执行文件路径…
        </div>
      )}
      {detectError && (
        <div className="environment-feedback environment-feedback-error">
          <XCircle size={15} />
          {detectError}
        </div>
      )}

      {tools && categories.map((category) => {
        const entries = normalizedTools.filter((tool) => tool.category === category.id)
        const readyCount = entries.filter((tool) => tool.found).length
        return (
          <div key={category.id} className="environment-group">
            <div className="environment-group-title">
              <strong>{category.label}</strong>
              <span>{category.detail}</span>
              <span className="ml-auto">{readyCount}/{entries.length} 就绪</span>
            </div>
            <div className="environment-list">
              {entries.length === 0 && (
                <div className="environment-row text-xs text-zinc-400">
                  此分组没有收到检测项。请重启 MoonGlass，使主进程与界面版本保持一致。
                </div>
              )}
              {entries.map((tool) => (
                <div key={tool.tool} className="environment-row">
                  {tool.found ? (
                    <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
                  ) : (
                    <XCircle size={16} className="shrink-0 text-zinc-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <strong className="text-sm text-zinc-700">{tool.tool}</strong>
                      <span className={`environment-importance importance-${tool.importance}`}>{tool.importance === 'required' ? '必要' : tool.importance === 'recommended' ? '推荐' : '可选'}</span>
                      <span className={tool.found ? 'text-xs text-emerald-700' : 'text-xs text-zinc-400'}>{tool.found ? '已就绪' : '未找到'}</span>
                      {tool.found && <span className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500">{tool.source === 'bundled' ? 'MoonGlass 内置' : tool.source === 'managed' ? 'MoonGlass 管理安装' : '系统环境'}</span>}
                      {!tool.found && tool.builtin && <span className="rounded border border-red-200 px-1.5 py-0.5 text-[10px] text-red-600">内置组件异常</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{tool.description}</p>
                    {tool.found && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400" title={tool.path}>{tool.version ?? tool.path}</p>
                    )}
                    {!tool.found && tool.builtin && <p className="mt-0.5 text-xs text-red-600">该工具应随 MoonGlass 提供，请重新安装或更换完整软件包。</p>}
                  </div>
                  {!tool.found && !tool.builtin && tool.installId && (
                    <button onClick={() => void installBundle(tool.installId!)} disabled={installing !== null} className="environment-install-button">
                      <Download size={13} />
                      {installing === tool.installId ? '安装中…' : tool.installId === 'python-cocotb' ? '安装 Cocotb' : '安装工具包'}
                    </button>
                  )}
                  {!tool.found && !tool.builtin && !tool.installId && tool.installUrl && (
                    <button onClick={() => void window.moonglass.eda.openInstallPage(tool.installUrl!)} className="environment-install-button" title="打开官方安装指南">
                      <ExternalLink size={14} />
                      安装指南
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
