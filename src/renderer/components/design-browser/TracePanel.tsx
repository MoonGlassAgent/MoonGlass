import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DesignDatabase, DesignEndpoint } from '@moonglass/design-browser-engine'
import {
  continueTrace,
  traceNet,
  type TraceContext,
  type TraceDirection,
  type TraceTarget
} from '@moonglass/design-browser-engine/trace'
import { useTranslation } from '../../i18n'

const KIND_BADGE: Record<DesignEndpoint['kind'], { text: string; className: string }> = {
  port: { text: 'PORT', className: 'bg-sky-100 text-sky-700' },
  cell: { text: 'CELL', className: 'bg-zinc-200 text-zinc-600' }
}

function EndpointRow({
  endpoint,
  expandable,
  expanded,
  onToggle,
  onJump,
  depth
}: {
  endpoint: DesignEndpoint
  expandable: boolean
  expanded: boolean
  onToggle: () => void
  onJump: () => void
  depth: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const badge = KIND_BADGE[endpoint.kind]
  return (
    <div
      className="flex items-center gap-1 py-0.5 pr-2 text-xs"
      style={{ paddingLeft: `${8 + depth * 14}px` }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? t('designBrowser.trace.collapseTrace') : t('designBrowser.trace.expandTrace')}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400 hover:text-blue-700"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${badge.className}`}>
        {badge.text}
      </span>
      <button
        type="button"
        onClick={onJump}
        title={endpoint.source ?? `${endpoint.name}.${endpoint.pin}`}
        className="min-w-0 truncate font-mono text-zinc-800 hover:text-blue-700 hover:underline"
      >
        {endpoint.name}.{endpoint.pin}
      </button>
      <span className="ml-auto shrink-0 pl-2 text-zinc-400">
        {endpoint.cellType ?? endpoint.direction}
      </span>
    </div>
  )
}

/** 跨边界追踪分支：另一个实例上下文中的 net 及其端点 */
function TraceBranch({
  database,
  target,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabase
  target: TraceTarget
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const endpoints = traceNet(database, target.context, target.net, direction)
  return (
    <div>
      <div
        className="py-0.5 pr-2 text-[10px] text-zinc-400"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={target.context.instancePath}
      >
        ⇢ <span className="font-mono text-zinc-500">{target.net}</span>
        <span className="ml-1">@ {target.context.instancePath}</span>
      </div>
      {endpoints.length === 0 ? (
        <p className="py-0.5 pr-2 text-[10px] text-zinc-300" style={{ paddingLeft: `${26 + depth * 14}px` }}>
          {direction === 'driver'
            ? t('designBrowser.trace.noFurtherDriver')
            : t('designBrowser.trace.noFurtherLoad')}
        </p>
      ) : (
        endpoints.slice(0, 100).map((endpoint, index) => (
          <EndpointNode
            key={`${endpoint.kind}-${endpoint.name}-${endpoint.pin}-${index}`}
            database={database}
            context={target.context}
            endpoint={endpoint}
            direction={direction}
            depth={depth + 1}
            onJumpSource={onJumpSource}
          />
        ))
      )}
    </div>
  )
}

/** 追踪树节点：端点 + 可懒加载展开的跨层次分支 */
function EndpointNode({
  database,
  context,
  endpoint,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabase
  context: TraceContext
  endpoint: DesignEndpoint
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // 预先计算跨边界目标，决定是否显示展开箭头（数据量小，可接受）
  const targets = continueTrace(database, context, endpoint, direction)
  return (
    <div>
      <EndpointRow
        endpoint={endpoint}
        expandable={targets.length > 0}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        onJump={() => onJumpSource(endpoint.source)}
        depth={depth}
      />
      {expanded &&
        targets.map((target, index) => (
          <TraceBranch
            key={`${target.context.instancePath}-${target.net}-${index}`}
            database={database}
            target={target}
            direction={direction}
            depth={depth + 1}
            onJumpSource={onJumpSource}
          />
        ))}
    </div>
  )
}

function TraceSection({
  title,
  database,
  context,
  net,
  direction,
  onJumpSource
}: {
  title: string
  database: DesignDatabase
  context: TraceContext
  net: string
  direction: TraceDirection
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const endpoints = traceNet(database, context, net, direction)
  return (
    <div>
      <h4 className="px-2 pb-1 pt-2 text-[10px] font-semibold text-zinc-500">
        {title}（{endpoints.length}）
      </h4>
      {endpoints.length === 0 ? (
        <p className="px-2 text-xs text-zinc-400">{t('common.none')}</p>
      ) : (
        endpoints.map((endpoint, index) => (
          <EndpointNode
            key={`${endpoint.kind}-${endpoint.name}-${endpoint.pin}-${index}`}
            database={database}
            context={context}
            endpoint={endpoint}
            direction={direction}
            depth={0}
            onJumpSource={onJumpSource}
          />
        ))
      )}
    </div>
  )
}

/** Inspector 中的信号追踪树（类 Verdi 逐层 Driver/Load 展开） */
export function TracePanel({
  database,
  context,
  net,
  onJumpSource
}: {
  database: DesignDatabase
  context: TraceContext
  net: string
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const module = database.modules.find((candidate) => candidate.name === context.module)
  const trace = module?.traces.find((candidate) => candidate.net === net)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-200 px-3 py-2">
        <p className="text-[10px] text-zinc-400">Signal</p>
        <p className="truncate font-mono text-sm font-semibold text-zinc-900" title={net}>
          {net}
        </p>
        <p className="truncate text-[10px] text-zinc-500" title={context.instancePath}>
          {context.instancePath} · {trace?.bits.length ?? 0} bits
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        <TraceSection
          title="DRIVERS"
          database={database}
          context={context}
          net={net}
          direction="driver"
          onJumpSource={onJumpSource}
        />
        <TraceSection
          title="LOADS / FANOUT"
          database={database}
          context={context}
          net={net}
          direction="load"
          onJumpSource={onJumpSource}
        />
      </div>
    </div>
  )
}
