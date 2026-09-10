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
import { LOCALES, setLocale, useTranslation, type MessageKey } from '../i18n'

const notifyLlmConfigurationChanged = (): void => {
  window.dispatchEvent(new Event('moonglass:llm-config-changed'))
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="mb-6 text-xl font-bold text-zinc-900">{t('settings.title')}</h1>
      <AppearanceSection />
      <LlmProviderSection />
      <EdaDetectSection />
      <section className="rounded-lg border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
        <h2 className="mb-1 font-semibold text-zinc-600">{t('settings.more.title')}</h2>
        {t('settings.more.description')}
      </section>
    </div>
  )
}

function AppearanceSection(): React.JSX.Element {
  const { t, locale } = useTranslation()

  return (
    <section className="surface-panel mb-5 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-800">{t('settings.appearance.title')}</h2>
        <p className="mt-0.5 text-xs text-zinc-500">{t('settings.appearance.description')}</p>
      </div>
      <ThemePicker />
      <div className="mt-4">
        <h3 className="mb-2 text-xs font-medium text-zinc-500">{t('common.language')}</h3>
        <div className="color-mode-picker" role="radiogroup" aria-label={t('common.language')}>
          {LOCALES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={locale === item.id}
              className={`color-mode-option ${locale === item.id ? 'is-selected' : ''}`}
              onClick={() => setLocale(item.id)}
            >
              <span>{item.name}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ==================== 模型服务 ====================

function LlmProviderSection(): React.JSX.Element {
  const { t } = useTranslation()
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
        error: t('settings.llm.testException', { message: err instanceof Error ? err.message : String(err) }),
        models: draft.models.map((model) => ({
          model,
          status: 'unknown',
          message: t('settings.llm.testExceptionModel')
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
      setSavedTip(enabled ? t('settings.llm.enabled') : t('settings.llm.disabled'))
      notifyLlmConfigurationChanged()
      setTimeout(() => setSavedTip(''), 1600)
    } catch (error) {
      setDraft(draft)
      setSavedTip(t('settings.llm.saveFailed', { message: error instanceof Error ? error.message : String(error) }))
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
      setSavedTip(saved.enabled ? t('settings.llm.savedEnabled') : t('settings.llm.savedDisabled'))
      notifyLlmConfigurationChanged()
      setTimeout(() => setSavedTip(''), 2000)
    } finally {
      setSaving(false)
    }
  }

  const addCustom = async (): Promise<void> => {
    const created = await window.moonglass.llm.upsert({
      id: crypto.randomUUID(),
      name: t('settings.llm.customProviderName'),
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
    <section className="surface-panel mb-8 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3">
        <h2 className="font-semibold text-zinc-800">{t('settings.llm.title')}</h2>
        <p className="mt-1 text-sm text-zinc-500">
          {t('settings.llm.description')}
        </p>
      </div>

      {!providers ? (
        <p className="text-sm text-zinc-500">{t('common.loading')}</p>
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
                        <span className="size-1.5 rounded-full bg-zinc-400" aria-label={t('settings.llm.noKey')} />
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
              + {t('settings.llm.addCustom')}
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
                  {t('settings.llm.enableProvider')}
                </label>
                <span className="text-xs text-zinc-500">
                  {t('settings.llm.protocol', { name: draft.protocol === 'anthropic' ? t('settings.llm.protocolAnthropic') : t('settings.llm.protocolOpenai') })}
                </span>
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">{t('settings.llm.name')}</label>
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
                    {showKey ? t('settings.llm.hideKey') : t('settings.llm.showKey')}
                  </button>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs text-zinc-500">{t('settings.llm.models')}</label>
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
                        aria-label={t('settings.llm.removeModel', { model: m })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {draft.models.length === 0 && (
                    <span className="text-xs text-zinc-400">{t('settings.llm.noModels')}</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={newModel}
                    onChange={(e) => setNewModel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addModel()}
                    placeholder={t('settings.llm.modelPlaceholder')}
                    className="w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-800"
                  />
                  <button
                    onClick={addModel}
                    className="shrink-0 rounded border border-zinc-300 px-3 text-sm text-zinc-700 hover:bg-zinc-100"
                  >
                    {t('settings.llm.add')}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? t('common.saving') : t('common.save')}
                </button>
                <button
                  onClick={() => void testProvider()}
                  disabled={testing || !draft.apiKey}
                  className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
                >
                  {testing ? t('settings.llm.testing') : t('settings.llm.testConnection')}
                </button>
                {!draft.builtin && (
                  <button
                    onClick={() => void remove()}
                    className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
                  >
                    {t('common.delete')}
                  </button>
                )}
                {savedTip && <span className="text-sm text-emerald-600">{savedTip}</span>}
              </div>

              {testResult && (
                <div className="border-t border-zinc-200 pt-3">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-medium text-zinc-500">{t('settings.llm.providerConnection')}</span>
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
                          ? t('settings.llm.httpFoundModels', { status: testResult.status ?? 200, count: testResult.availableModelCount })
                          : t('settings.llm.httpProbedModels', { status: testResult.status ?? 200, count: testResult.models.length })
                        : testResult.error ?? t('settings.llm.unknownError')}
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
                          <th className="py-1.5 pr-3 font-medium">{t('settings.llm.thModelId')}</th>
                          <th className="w-24 py-1.5 pr-3 font-medium">{t('settings.llm.thStatus')}</th>
                          <th className="py-1.5 font-medium">{t('settings.llm.thNote')}</th>
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
                                    : t('settings.llm.statusUntested')}
                              </span>
                            </td>
                            <td className="py-1.5 text-zinc-500">{model.message}</td>
                          </tr>
                        ))}
                        {testResult.models.length === 0 && (
                          <tr>
                            <td colSpan={3} className="py-2 text-zinc-400">
                              {t('settings.llm.noModelIds')}
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
  const { t } = useTranslation()
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
      if (detected.length === 0) setDetectError(t('settings.eda.noItems'))
    } catch (error) {
      setTools([])
      setDetectError(t('settings.eda.detectFailed', { message: error instanceof Error ? error.message : String(error) }))
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
          setInstallMessage(t('settings.eda.installStatusFailed', { message: error instanceof Error ? error.message : String(error) }))
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
      ? t('settings.eda.confirmCocotb')
      : t('settings.eda.confirmOssCad')
    if (!window.confirm(prompt)) return
    setInstalling(id)
    setInstallMessage(id === 'python-cocotb' ? t('settings.eda.installingCocotb') : t('settings.eda.installingBundle'))
    try {
      const job = await window.moonglass.eda.installBundle(id)
      setInstallMessage(job.message)
    } catch (error) {
      setInstallMessage(t('settings.eda.installStartFailed', { message: error instanceof Error ? error.message : String(error) }))
      setInstalling(null)
    }
  }

  const categories: Array<{ id: NonNullable<ToolDetection['category']>; labelKey: MessageKey; detailKey: MessageKey }> = [
    { id: 'runtime', labelKey: 'settings.eda.categories.runtime.label', detailKey: 'settings.eda.categories.runtime.detail' },
    { id: 'build', labelKey: 'settings.eda.categories.build.label', detailKey: 'settings.eda.categories.build.detail' },
    { id: 'eda', labelKey: 'settings.eda.categories.eda.label', detailKey: 'settings.eda.categories.eda.detail' },
    { id: 'verification', labelKey: 'settings.eda.categories.verification.label', detailKey: 'settings.eda.categories.verification.detail' },
    { id: 'physical', labelKey: 'settings.eda.categories.physical.label', detailKey: 'settings.eda.categories.physical.detail' }
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
    description: tool.description ?? t('settings.eda.legacyDescription')
  }))

  return (
    <section className="surface-panel mb-8 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-zinc-800">{t('settings.eda.title')}</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {t('settings.eda.description')}
          </p>
        </div>
        <button
          onClick={() => void detect(true)}
          disabled={detecting}
          className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <RefreshCw size={14} className={detecting ? 'animate-spin' : ''} />
          {detecting ? t('settings.eda.detecting') : t('settings.eda.redetect')}
        </button>
      </div>

      {installMessage && (
        <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">{installMessage}</div>
      )}

      {detecting && tools === null && (
        <div className="environment-feedback">
          <RefreshCw size={15} className="animate-spin" />
          {t('settings.eda.detectingDetail')}
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
              <strong>{t(category.labelKey)}</strong>
              <span>{t(category.detailKey)}</span>
              <span className="ml-auto">{t('settings.eda.ready', { ready: readyCount, total: entries.length })}</span>
            </div>
            <div className="environment-list">
              {entries.length === 0 && (
                <div className="environment-row text-xs text-zinc-400">
                  {t('settings.eda.emptyGroup')}
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
                      <span className={`environment-importance importance-${tool.importance}`}>{tool.importance === 'required' ? t('settings.eda.importance.required') : tool.importance === 'recommended' ? t('settings.eda.importance.recommended') : t('settings.eda.importance.optional')}</span>
                      <span className={tool.found ? 'text-xs text-emerald-700' : 'text-xs text-zinc-400'}>{tool.found ? t('settings.eda.statusReady') : t('settings.eda.statusNotFound')}</span>
                      {tool.found && <span className="rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-500">{tool.source === 'bundled' ? t('settings.eda.source.bundled') : tool.source === 'managed' ? t('settings.eda.source.managed') : t('settings.eda.source.system')}</span>}
                      {!tool.found && tool.builtin && <span className="rounded border border-red-200 px-1.5 py-0.5 text-[10px] text-red-600">{t('settings.eda.builtinError')}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{tool.description}</p>
                    {tool.found && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-400" title={tool.path}>{tool.version ?? tool.path}</p>
                    )}
                    {!tool.found && tool.builtin && <p className="mt-0.5 text-xs text-red-600">{t('settings.eda.builtinErrorDetail')}</p>}
                  </div>
                  {!tool.found && !tool.builtin && tool.installId && (
                    <button onClick={() => void installBundle(tool.installId!)} disabled={installing !== null} className="environment-install-button">
                      <Download size={13} />
                      {installing === tool.installId ? t('settings.eda.installing') : tool.installId === 'python-cocotb' ? t('settings.eda.installCocotb') : t('settings.eda.installBundle')}
                    </button>
                  )}
                  {!tool.found && !tool.builtin && !tool.installId && tool.installUrl && (
                    <button onClick={() => void window.moonglass.eda.openInstallPage(tool.installUrl!)} className="environment-install-button" title={t('settings.eda.openGuideTitle')}>
                      <ExternalLink size={14} />
                      {t('settings.eda.installGuide')}
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
