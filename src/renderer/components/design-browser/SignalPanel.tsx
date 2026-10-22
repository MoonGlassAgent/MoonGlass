import { useMemo, useState } from 'react'
import type { DesignModule, DesignModuleV2, DesignPortV2 } from '@moonglass/design-browser-engine'
import { useTranslation } from '../../i18n'
import { displayModuleName } from './module-name'

const DIRECTION_BADGE: Record<DesignPortV2['direction'], string> = {
  input: 'bg-sky-100 text-sky-700',
  output: 'bg-emerald-100 text-emerald-700',
  inout: 'bg-amber-100 text-amber-700'
}

const KIND_BADGE: Record<string, string> = {
  wire: 'bg-zinc-200 text-zinc-600',
  reg: 'bg-violet-100 text-violet-700',
  logic: 'bg-cyan-100 text-cyan-700',
  other: 'bg-zinc-100 text-zinc-500'
}

/** 信号 kind 徽标文案（wire/reg/logic 为类型标识符，不翻译）；动态 kind 映射为字面量 i18n key */
function kindLabelKey(kind: string):
  | 'designBrowser.signals.kinds.wire'
  | 'designBrowser.signals.kinds.reg'
  | 'designBrowser.signals.kinds.logic'
  | 'designBrowser.signals.kinds.other' {
  if (kind === 'wire') return 'designBrowser.signals.kinds.wire'
  if (kind === 'reg') return 'designBrowser.signals.kinds.reg'
  if (kind === 'logic') return 'designBrowser.signals.kinds.logic'
  return 'designBrowser.signals.kinds.other'
}

/** 端口方向徽标文案（in / out / inout 为方向标识符，不翻译） */
function directionLabel(direction: DesignPortV2['direction']): string {
  return direction === 'input' ? 'in' : direction === 'output' ? 'out' : 'inout'
}

/** 端口分组行的归一化形状（v3 端口信号 / v2 端口统一走这条渲染） */
interface PortRow {
  name: string
  direction: DesignPortV2['direction']
  width: number
  kindBadge?: string
}

/**
 * 中部下方信号列表：端口分组 + 当前模块内部信号一览（类 Verdi 信号窗格）。
 * 双形态：v3（slang）用 signals（isPort 分组 + kind 徽标）；v2（Yosys 回退）用 nets。
 */
export function SignalPanel({
  module,
  selectedNet,
  onSelect
}: {
  module: DesignModule | DesignModuleV2 | null
  selectedNet: string | null
  onSelect: (net: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (module && 'signals' in module) {
      const toRow = (signal: (typeof module.signals)[number]): PortRow => ({
        name: signal.name,
        direction: signal.direction ?? 'input',
        width: signal.width,
        kindBadge: signal.kind
      })
      const ports = module.signals.filter((signal) => signal.isPort).map(toRow)
      const internal = module.signals.filter((signal) => !signal.isPort)
      if (!needle) return { v3: true as const, ports, internal }
      return {
        v3: true as const,
        ports: ports.filter((port) => port.name.toLowerCase().includes(needle)),
        internal: internal.filter((signal) => signal.name.toLowerCase().includes(needle))
      }
    }
    // v2（Yosys 回退形态，冻结）：端口也是 net，内部信号区排除与端口同名的 trace
    const portNames = new Set((module?.ports ?? []).map((port) => port.name))
    const ports: PortRow[] = module?.ports ?? []
    const traces = (module?.traces ?? []).filter((trace) => !portNames.has(trace.net))
    if (!needle) return { v3: false as const, ports, traces }
    return {
      v3: false as const,
      ports: ports.filter((port) => port.name.toLowerCase().includes(needle)),
      traces: traces.filter((trace) => trace.net.toLowerCase().includes(needle))
    }
  }, [module, query])

  const totalInternal = module && 'signals' in module
    ? module.signals.filter((signal) => !signal.isPort).length
    : (module?.traces.length ?? 0)
  const internalEmpty = filtered.v3 ? filtered.internal.length === 0 : filtered.traces.length === 0
  const v3Module = module && 'signals' in module ? module : null

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center border-b border-zinc-200 px-3 py-1.5">
        <h3 className="text-xs font-semibold text-zinc-600">{t('designBrowser.signals.title')}</h3>
        {module && (
          <span className="ml-2 text-[10px] text-zinc-400">
            {t('designBrowser.signals.count', {
              module: displayModuleName(module.name),
              shown: filtered.v3 ? filtered.internal.length : filtered.traces.length,
              total: totalInternal
            })}
          </span>
        )}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('designBrowser.signals.searchPlaceholder')}
          className="ml-auto w-48 rounded border border-zinc-300 px-2 py-0.5 text-xs"
        />
      </div>
      {module ? (
        <div className="grid min-h-0 flex-1 grid-cols-3 content-start overflow-auto">
          {filtered.ports.length > 0 && (
            <>
              <p className="col-span-3 bg-zinc-50 px-2 py-1 text-[10px] font-semibold text-zinc-500">
                {t('designBrowser.signals.ports')}
              </p>
              {filtered.ports.map((port) => (
                <button
                  key={port.name}
                  type="button"
                  onClick={() => onSelect(port.name)}
                  title={`${port.name} · ${directionLabel(port.direction)} [${port.width}]`}
                  className={`border-b border-r border-zinc-100 px-2 py-1.5 text-left text-xs ${
                    selectedNet === port.name ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-50'
                  }`}
                >
                  <span className="font-mono">{port.name}</span>
                  {port.kindBadge && (
                    <span className={`ml-2 rounded px-1 text-[9px] font-semibold ${KIND_BADGE[port.kindBadge]}`}>
                      {t(kindLabelKey(port.kindBadge))}
                    </span>
                  )}
                  <span
                    className={`ml-2 rounded px-1 text-[9px] font-semibold ${DIRECTION_BADGE[port.direction]}`}
                  >
                    {directionLabel(port.direction)}
                  </span>
                  <span className="ml-1 text-zinc-400">[{port.width}]</span>
                </button>
              ))}
            </>
          )}
          {filtered.v3 ? (
            v3Module && filtered.internal.length > 0 && (
              <>
                <p className="col-span-3 bg-zinc-50 px-2 py-1 text-[10px] font-semibold text-zinc-500">
                  {t('designBrowser.signals.internalSignals')}
                </p>
                {filtered.internal.map((signal) => {
                  const trace = v3Module.traces.find((candidate) => candidate.net === signal.name)
                  return (
                    <button
                      key={signal.name}
                      type="button"
                      onClick={() => onSelect(signal.name)}
                      title={`${signal.name} · ${signal.kind} [${signal.width}] · Driver ${trace?.drivers.length ?? 0} / Load ${trace?.loads.length ?? 0}`}
                      className={`border-b border-r border-zinc-100 px-2 py-1.5 text-left text-xs ${
                        selectedNet === signal.name ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-50'
                      }`}
                    >
                      <span className="font-mono">{signal.name}</span>
                      <span className={`ml-2 rounded px-1 text-[9px] font-semibold ${KIND_BADGE[signal.kind]}`}>
                        {t(kindLabelKey(signal.kind))}
                      </span>
                      <span className="ml-1 text-zinc-400">
                        [{signal.width}] D{trace?.drivers.length ?? 0}/L{trace?.loads.length ?? 0}
                      </span>
                    </button>
                  )
                })}
              </>
            )
          ) : (
            filtered.traces.length > 0 && (
              <>
                <p className="col-span-3 bg-zinc-50 px-2 py-1 text-[10px] font-semibold text-zinc-500">
                  {t('designBrowser.signals.internalSignals')}
                </p>
                {filtered.traces.map((trace) => (
                  <button
                    key={trace.net}
                    type="button"
                    onClick={() => onSelect(trace.net)}
                    title={`${trace.net} · Driver ${trace.drivers.length} / Load ${trace.loads.length}`}
                    className={`border-b border-r border-zinc-100 px-2 py-1.5 text-left text-xs ${
                      selectedNet === trace.net ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-50'
                    }`}
                  >
                    <span className="font-mono">{trace.net}</span>
                    <span className="ml-2 text-zinc-400">
                      [{trace.bits.length}] D{trace.drivers.length}/L{trace.loads.length}
                    </span>
                  </button>
                ))}
              </>
            )
          )}
          {filtered.ports.length === 0 && internalEmpty && (
            <p className="col-span-3 px-3 py-2 text-xs text-zinc-400">{t('designBrowser.signals.noMatchingSignals')}</p>
          )}
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-zinc-400">{t('designBrowser.signals.noModuleSelected')}</p>
      )}
    </div>
  )
}
