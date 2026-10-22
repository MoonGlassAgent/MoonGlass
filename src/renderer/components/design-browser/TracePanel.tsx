import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { DesignDatabase, DesignDatabaseV2, DesignDatabaseV3, DesignEndpoint, DesignEndpointV2 } from '@moonglass/design-browser-engine'
import {
  continueTrace,
  continueTraceV2,
  traceNet,
  traceNetV2,
  type TraceContext,
  type TraceDirection,
  type TraceTarget
} from '@moonglass/design-browser-engine/trace'
import { useTranslation } from '../../i18n'

/** v3 端点徽标样式：PORT / PIN / STMT 三态 */
const V3_BADGE_CLASS: Record<DesignEndpoint['kind'], string> = {
  port: 'bg-sky-100 text-sky-700',
  instancePin: 'bg-indigo-100 text-indigo-700',
  statement: 'bg-emerald-100 text-emerald-700'
}

function EndpointRow({
  badge,
  badgeClass,
  label,
  detail,
  title,
  expandable,
  expanded,
  onToggle,
  onJump,
  depth
}: {
  badge: string
  badgeClass: string
  label: string
  detail?: string
  title?: string
  expandable: boolean
  expanded: boolean
  onToggle: () => void
  onJump: () => void
  depth: number
}): React.JSX.Element {
  const { t } = useTranslation()
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
      <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${badgeClass}`}>
        {badge}
      </span>
      <button
        type="button"
        onClick={onJump}
        title={title ?? label}
        className="min-w-0 truncate font-mono text-zinc-800 hover:text-blue-700 hover:underline"
      >
        {label}
      </button>
      {detail && <span className="ml-auto shrink-0 pl-2 text-zinc-400">{detail}</span>}
    </div>
  )
}

/** 跨边界追踪分支（v3）：另一个实例上下文中的 net 及其端点 */
function TraceBranchV3({
  database,
  target,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabaseV3
  target: TraceTarget
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const endpoints = traceNet(database, target.context, target.net, direction)
  const shownEndpoints = endpoints.slice(0, 100)
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
        <>
          {shownEndpoints.map((endpoint, index) => (
            <EndpointNodeV3
              key={`${endpoint.kind}-${endpoint.label}-${index}`}
              database={database}
              context={target.context}
              endpoint={endpoint}
              direction={direction}
              depth={depth + 1}
              onJumpSource={onJumpSource}
            />
          ))}
          {endpoints.length > shownEndpoints.length && (
            <p className="py-0.5 pr-2 text-[10px] text-zinc-400" style={{ paddingLeft: `${26 + depth * 14}px` }}>
              {t('designBrowser.trace.moreEndpoints', { count: endpoints.length - shownEndpoints.length })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** v3 追踪树节点：端点 + 可懒加载展开的跨层次分支 */
function EndpointNodeV3({
  database,
  context,
  endpoint,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabaseV3
  context: TraceContext
  endpoint: DesignEndpoint
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  // 预先计算跨边界目标，决定是否显示展开箭头（数据量小，可接受）
  const targets = continueTrace(database, context, endpoint, direction)
  const badge = endpoint.kind === 'port'
    ? t('designBrowser.trace.badges.port')
    : endpoint.kind === 'instancePin'
      ? t('designBrowser.trace.badges.pin')
      : t('designBrowser.trace.badges.stmt')
  return (
    <div>
      <EndpointRow
        badge={badge}
        badgeClass={V3_BADGE_CLASS[endpoint.kind]}
        label={endpoint.kind === 'port' ? endpoint.label.replace(/^PORT\s+/, '') : endpoint.label}
        detail={endpoint.direction}
        title={endpoint.source}
        expandable={targets.length > 0}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        onJump={() => onJumpSource(endpoint.source)}
        depth={depth}
      />
      {expanded &&
        targets.map((target, index) => (
          <TraceBranchV3
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

function TraceSectionV3({
  title,
  database,
  context,
  net,
  direction,
  onJumpSource
}: {
  title: string
  database: DesignDatabaseV3
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
          <EndpointNodeV3
            key={`${endpoint.kind}-${endpoint.label}-${index}`}
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

// ---- v2（Yosys 回退形态，冻结） ----

function TraceBranchV2({
  database,
  target,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabaseV2
  target: TraceTarget
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const endpoints = traceNetV2(database, target.context, target.net, direction)
  const shownEndpoints = endpoints.slice(0, 100)
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
        <>
          {shownEndpoints.map((endpoint, index) => (
            <EndpointNodeV2
              key={`${endpoint.kind}-${endpoint.name}-${endpoint.pin}-${index}`}
              database={database}
              context={target.context}
              endpoint={endpoint}
              direction={direction}
              depth={depth + 1}
              onJumpSource={onJumpSource}
            />
          ))}
          {endpoints.length > shownEndpoints.length && (
            <p className="py-0.5 pr-2 text-[10px] text-zinc-400" style={{ paddingLeft: `${26 + depth * 14}px` }}>
              {t('designBrowser.trace.moreEndpoints', { count: endpoints.length - shownEndpoints.length })}
            </p>
          )}
        </>
      )}
    </div>
  )
}

function EndpointNodeV2({
  database,
  context,
  endpoint,
  direction,
  depth,
  onJumpSource
}: {
  database: DesignDatabaseV2
  context: TraceContext
  endpoint: DesignEndpointV2
  direction: TraceDirection
  depth: number
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const targets = continueTraceV2(database, context, endpoint, direction)
  const badge = endpoint.kind === 'port'
    ? { text: t('designBrowser.trace.badges.port'), className: 'bg-sky-100 text-sky-700' }
    : { text: t('designBrowser.trace.badges.cell'), className: 'bg-zinc-200 text-zinc-600' }
  return (
    <div>
      <EndpointRow
        badge={badge.text}
        badgeClass={badge.className}
        label={`${endpoint.name}.${endpoint.pin}`}
        detail={endpoint.cellType ?? endpoint.direction}
        title={endpoint.source ?? `${endpoint.name}.${endpoint.pin}`}
        expandable={targets.length > 0}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
        onJump={() => onJumpSource(endpoint.source)}
        depth={depth}
      />
      {expanded &&
        targets.map((target, index) => (
          <TraceBranchV2
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

function TraceSectionV2({
  title,
  database,
  context,
  net,
  direction,
  onJumpSource
}: {
  title: string
  database: DesignDatabaseV2
  context: TraceContext
  net: string
  direction: TraceDirection
  onJumpSource: (source?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const endpoints = traceNetV2(database, context, net, direction)
  return (
    <div>
      <h4 className="px-2 pb-1 pt-2 text-[10px] font-semibold text-zinc-500">
        {title}（{endpoints.length}）
      </h4>
      {endpoints.length === 0 ? (
        <p className="px-2 text-xs text-zinc-400">{t('common.none')}</p>
      ) : (
        endpoints.map((endpoint, index) => (
          <EndpointNodeV2
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

/** Inspector 中的信号追踪树（类 Verdi 逐层 Driver/Load 展开；v3/v2 双形态） */
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
  const { t } = useTranslation()
  const module = database.modules.find((candidate) => candidate.name === context.module)
  const trace = module?.traces.find((candidate) => candidate.net === net)
  const width = trace && 'width' in trace ? trace.width : (trace?.bits.length ?? 0)
  const sectionProps = { context, net, onJumpSource }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-200 px-3 py-2">
        <p className="text-[10px] text-zinc-400">{t('designBrowser.trace.signal')}</p>
        <p className="truncate font-mono text-sm font-semibold text-zinc-900" title={net}>
          {net}
        </p>
        <p className="truncate text-[10px] text-zinc-500" title={context.instancePath}>
          {context.instancePath} · {width} bits
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {database.version === 3 ? (
          <>
            <TraceSectionV3 title={t('designBrowser.trace.drivers')} database={database} direction="driver" {...sectionProps} />
            <TraceSectionV3 title={t('designBrowser.trace.loads')} database={database} direction="load" {...sectionProps} />
          </>
        ) : (
          <>
            <TraceSectionV2 title={t('designBrowser.trace.drivers')} database={database} direction="driver" {...sectionProps} />
            <TraceSectionV2 title={t('designBrowser.trace.loads')} database={database} direction="load" {...sectionProps} />
          </>
        )}
      </div>
    </div>
  )
}
