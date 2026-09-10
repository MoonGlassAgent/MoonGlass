import { useMemo, useState } from 'react'
import type { DesignModule } from '@moonglass/design-browser-engine'
import { useTranslation } from '../../i18n'
import { displayModuleName } from './module-name'

/** 中部下方信号列表：当前模块的 net 一览（类 Verdi 信号窗格） */
export function SignalPanel({
  module,
  selectedNet,
  onSelect
}: {
  module: DesignModule | null
  selectedNet: string | null
  onSelect: (net: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const traces = module?.traces ?? []
    const needle = query.trim().toLowerCase()
    return needle ? traces.filter((trace) => trace.net.toLowerCase().includes(needle)) : traces
  }, [module, query])

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center border-b border-zinc-200 px-3 py-1.5">
        <h3 className="text-xs font-semibold text-zinc-600">SIGNALS</h3>
        {module && (
          <span className="ml-2 text-[10px] text-zinc-400">
            {displayModuleName(module.name)} · {filtered.length}/{module.traces.length} nets
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
          {filtered.map((trace) => (
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
          {filtered.length === 0 && (
            <p className="col-span-3 px-3 py-2 text-xs text-zinc-400">{t('designBrowser.signals.noMatchingSignals')}</p>
          )}
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-zinc-400">{t('designBrowser.signals.noModuleSelected')}</p>
      )}
    </div>
  )
}
