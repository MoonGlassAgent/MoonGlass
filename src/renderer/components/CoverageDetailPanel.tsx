/**
 * 覆盖率明细面板
 *
 * 基于 Verilator coverage.dat（经主进程 CoverageService 解析/缓存）的逐检测点视图：
 * 概览条 + 类型 tab + 按文件聚合的检测点表（可展开逐点列表、对照源码逐行 gutter）。
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FileCode2, XCircle } from 'lucide-react'
import type { CoverageDetailResult, FileTreeNode } from '@shared/types'
import { useTranslation, type MessageKey } from '../i18n'

interface RegressionEntry {
  resultFile: string
  passed: boolean
  testsTotal: number
  coverage: Record<string, number>
}

/** 明细视图的类型 tab（fsm 合并 fsm_state 与 fsm_arc） */
type CoverageKind = 'line' | 'branch' | 'expr' | 'toggle' | 'fsm'

const KIND_ORDER: CoverageKind[] = ['line', 'branch', 'expr', 'toggle', 'fsm']
const KIND_LABEL_KEYS: Record<CoverageKind, MessageKey> = {
  line: 'verification.coverageDetail.kindNames.line',
  branch: 'verification.coverageDetail.kindNames.branch',
  expr: 'verification.coverageDetail.kindNames.expression',
  toggle: 'verification.coverageDetail.kindNames.toggle',
  fsm: 'verification.coverageDetail.kindNames.fsm'
}
const POINT_KINDS: Record<CoverageKind, string[]> = {
  line: ['line'],
  branch: ['branch'],
  expr: ['expr'],
  toggle: ['toggle'],
  fsm: ['fsm_state', 'fsm_arc']
}

/** 源码视图：成功读取或映射失败两种终态 */
type SourceState =
  | { file: string; rel: string; content: string; truncated: boolean }
  | { file: string; error: true }

/** 收集文件树中的全部文件相对路径（统一 posix 分隔符）。 */
function collectTreeFiles(nodes: FileTreeNode[], acc: string[]): string[] {
  for (const node of nodes) {
    if (node.type === 'file') acc.push(node.path.replace(/\\/g, '/'))
    else collectTreeFiles(node.children ?? [], acc)
  }
  return acc
}

/** 覆盖率 dat 中的绝对路径 → 工作区相对路径：优先截取 workspaces/<uuid>/ 之后部分。 */
function workspaceRel(file: string): string | null {
  const match = /\/workspaces\/[^/]+\/(.+)$/.exec(file.replace(/\\/g, '/'))
  return match ? match[1] : null
}

export function CoverageDetailPanel({ projectId, regressions }: { projectId: string; regressions: RegressionEntry[] }): React.JSX.Element {
  const { t } = useTranslation()
  const [scenarios, setScenarios] = useState<string[]>([])
  const [scenario, setScenario] = useState('')
  const [detail, setDetail] = useState<CoverageDetailResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [kind, setKind] = useState<CoverageKind>('line')
  const [uncoveredOnly, setUncoveredOnly] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [treeFiles, setTreeFiles] = useState<string[]>([])
  const [source, setSource] = useState<SourceState | null>(null)

  // 场景列表：优先取回归结果目录；无回归时用文件树兜底下含 coverage.dat 的目录
  useEffect(() => {
    let alive = true
    void (async () => {
      let tree: FileTreeNode[] = []
      try {
        tree = await window.moonglass.fs.tree(projectId)
      } catch { tree = [] }
      const files = collectTreeFiles(tree, [])
      if (!alive) return
      setTreeFiles(files)
      let dirs = [...new Set(regressions
        .map((entry) => entry.resultFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/'))
        .filter(Boolean))]
      if (dirs.length === 0) {
        const prefix = 'verification/results/'
        dirs = [...new Set(files
          .filter((file) => file.startsWith(prefix) && file.endsWith('/coverage.dat'))
          .map((file) => file.slice(0, file.lastIndexOf('/'))))]
      }
      setScenarios(dirs)
      setScenario((prev) => (dirs.includes(prev) ? prev : dirs[0] ?? ''))
    })()
    return () => { alive = false }
  }, [projectId, regressions])

  // 选中场景变化时加载覆盖率明细（主进程优先缓存、回退解析 coverage.dat）
  useEffect(() => {
    if (!scenario) { setDetail(null); return }
    let alive = true
    void (async () => {
      setLoading(true); setLoadError('')
      try {
        const result = await window.moonglass.coverage.detail(projectId, scenario)
        if (alive) setDetail(result)
      } catch (caught) {
        if (alive) { setDetail(null); setLoadError(caught instanceof Error ? caught.message : String(caught)) }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [projectId, scenario])

  // 功能覆盖率取选中场景对应回归条目里的 functionalCoverage
  const functionalCoverage = useMemo(() => {
    const entry = regressions.find((item) => item.resultFile.replace(/\\/g, '/').split('/').slice(0, -1).join('/') === scenario)
    return entry?.coverage.functionalCoverage
  }, [regressions, scenario])

  const fileRows = useMemo(() => {
    if (!detail) return []
    const kinds = POINT_KINDS[kind]
    return detail.files
      .map((fileDetail) => {
        const typed = fileDetail.points.filter((point) => kinds.includes(point.kind))
        const covered = typed.filter((point) => point.hits > 0).length
        return {
          file: fileDetail.file,
          total: typed.length,
          covered,
          uncovered: typed.length - covered,
          points: typed.filter((point) => !uncoveredOnly || point.hits === 0)
        }
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.uncovered - a.uncovered || (a.covered / a.total) - (b.covered / b.total) || a.file.localeCompare(b.file))
  }, [detail, kind, uncoveredOnly])

  const overview = useMemo(() => {
    const summary = detail?.summary
    return [
      { key: 'verification.coverageDetail.kindNames.line' as MessageKey, value: summary?.line },
      { key: 'verification.coverageDetail.kindNames.branch' as MessageKey, value: summary?.branch },
      { key: 'verification.coverageDetail.kindNames.expression' as MessageKey, value: summary?.expression },
      { key: 'verification.coverageDetail.kindNames.toggle' as MessageKey, value: summary?.toggle },
      { key: 'verification.coverageDetail.kindNames.fsm' as MessageKey, value: summary?.fsm },
      { key: 'verification.coverageDetail.kindNames.functional' as MessageKey, value: functionalCoverage }
    ]
  }, [detail, functionalCoverage])

  const toggleSource = useCallback(async (file: string) => {
    if (source?.file === file) { setSource(null); return }
    let rel = workspaceRel(file)
    if (!rel) {
      // 截取 workspaces/<uuid>/ 失败时按 basename 在文件树中匹配
      const base = file.replace(/\\/g, '/').split('/').pop() ?? ''
      rel = treeFiles.find((candidate) => candidate.split('/').pop() === base) ?? null
    }
    if (!rel) { setSource({ file, error: true }); return }
    try {
      const result = await window.moonglass.fs.readFile(projectId, rel)
      if (!result) { setSource({ file, error: true }); return }
      setSource({ file, rel, content: result.content, truncated: result.truncated })
    } catch {
      setSource({ file, error: true })
    }
  }, [projectId, source, treeFiles])

  /** 逐点列表的类型列：expr → 表达式，fsm_state/fsm_arc → FSM */
  const pointKindLabel = (pointKind: string): string =>
    pointKind === 'expr' ? t(KIND_LABEL_KEYS.expr)
      : pointKind.startsWith('fsm_') ? t(KIND_LABEL_KEYS.fsm)
        : t(KIND_LABEL_KEYS[pointKind as CoverageKind])

  const sourceLines = useMemo(() => {
    if (!source || 'error' in source) return []
    const fileDetail = detail?.files.find((item) => item.file === source.file)
    const byLine = new Map<number, number[]>()
    for (const point of fileDetail?.points ?? []) {
      const hits = byLine.get(point.line) ?? []
      hits.push(point.hits)
      byLine.set(point.line, hits)
    }
    return source.content.split('\n').map((text, index) => {
      const hits = byLine.get(index + 1) ?? []
      return { no: index + 1, text, hits, hasUncovered: hits.some((hit) => hit === 0) }
    })
  }, [source, detail])

  return <section className="border-t border-zinc-200 bg-white p-5">
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-sm font-semibold">{t('verification.coverageDetail.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.coverageDetail.subtitle')}</p></div>
      {scenarios.length > 0 && <label className="flex items-center gap-2 text-xs text-zinc-500">
        {t('verification.coverageDetail.scenario')}
        <select value={scenario} onChange={(event) => { setScenario(event.target.value); setExpanded(null); setSource(null) }} className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-[11px] text-zinc-700">
          {scenarios.map((dir) => <option key={dir} value={dir}>{dir.replace(/^verification\/results\//, '')}</option>)}
        </select>
      </label>}
    </div>

    {scenarios.length === 0 && <div className="flex items-center gap-2 border-y border-zinc-200 px-2 py-6 text-sm text-zinc-400"><XCircle size={16} className="text-zinc-300" />{t('verification.coverageDetail.noScenario')}</div>}

    {scenarios.length > 0 && <>
      {/* 概览条：行/条件/表达式/翻转/FSM 取自明细 summary，功能覆盖率取自回归结果 */}
      <div className="mb-4 flex flex-wrap gap-3">
        {overview.map((item) => <div key={item.key} className="min-w-20 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-center">
          <div className={`text-lg font-semibold ${item.value === undefined ? 'text-zinc-300' : item.value === 100 ? 'text-emerald-600' : 'text-zinc-900'}`}>{item.value === undefined ? '-' : `${item.value}%`}</div>
          <div className="text-[10px] text-zinc-500">{t(item.key)}</div>
        </div>)}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex rounded border border-zinc-300">
          {KIND_ORDER.map((item) => <button key={item} onClick={() => setKind(item)} className={`px-3 py-1 text-[11px] ${kind === item ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 hover:bg-zinc-100'}`}>{t(KIND_LABEL_KEYS[item])}</button>)}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-600">
          <input type="checkbox" checked={uncoveredOnly} onChange={(event) => setUncoveredOnly(event.target.checked)} className="accent-emerald-600" />
          {t('verification.coverageDetail.uncoveredOnly')}
        </label>
        <span className="ml-auto text-[11px] text-zinc-400">{detail ? new Date(detail.generatedAt).toLocaleString() : ''}</span>
      </div>

      {loading && <div className="border-y border-zinc-200 px-2 py-6 text-center text-sm text-zinc-400">{t('verification.coverageDetail.loading')}</div>}
      {!loading && loadError && <div className="border-y border-red-200 bg-red-50 px-2 py-3 text-xs text-red-700">{t('verification.coverageDetail.loadFailed', { message: loadError })}</div>}
      {!loading && !loadError && !detail && <div className="flex items-center gap-2 border-y border-zinc-200 px-2 py-6 text-sm text-zinc-400"><XCircle size={16} className="text-zinc-300" />{t('verification.coverageDetail.noRtlCoverage')}</div>}
      {!loading && !loadError && detail && <>
        {fileRows.length === 0 && <div className="border-y border-zinc-200 px-2 py-6 text-center text-sm text-zinc-400">{t('verification.coverageDetail.emptyPoints')}</div>}
        {fileRows.length > 0 && <div className="max-h-[480px] overflow-auto border-y border-zinc-200">
          <table className="w-full table-fixed text-left text-[11px]">
            <thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr>
              <th className="px-2 py-2 font-medium">{t('verification.coverageDetail.colFile')}</th>
              <th className="w-24 px-2 py-2 text-right font-medium">{t('verification.coverageDetail.colCovered')}</th>
              <th className="w-20 px-2 py-2 text-right font-medium">{t('verification.coverageDetail.colTotal')}</th>
              <th className="w-24 px-2 py-2 text-right font-medium">{t('verification.coverageDetail.colPercent')}</th>
              <th className="w-20 px-2 py-2 font-medium" />
            </tr></thead>
            <tbody>
              {fileRows.map((row) => {
                const percent = row.total > 0 ? (row.covered / row.total) * 100 : 0
                const open = expanded === row.file
                return <Fragment key={row.file}>
                  <tr onClick={() => setExpanded(open ? null : row.file)} className={`cursor-pointer border-t border-zinc-100 align-top ${open ? 'bg-zinc-50' : 'hover:bg-zinc-50/60'}`}>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">{open ? <ChevronDown size={12} className="shrink-0 text-zinc-400" /> : <ChevronRight size={12} className="shrink-0 text-zinc-400" />}<span className="truncate font-mono text-zinc-700" title={row.file}>{workspaceRel(row.file) ?? row.file.replace(/\\/g, '/').split('/').pop()}</span></div>
                      <div className="mt-0.5 pl-4 text-[10px] text-zinc-400">{t('verification.coverageDetail.pointsSummary', { total: row.total, uncovered: row.uncovered })}</div>
                    </td>
                    <td className={`px-2 py-2 text-right ${row.covered === row.total ? 'text-emerald-700' : 'text-zinc-700'}`}>{row.covered}</td>
                    <td className="px-2 py-2 text-right text-zinc-500">{row.total}</td>
                    <td className={`px-2 py-2 text-right font-semibold ${row.uncovered > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{percent.toFixed(2)}%</td>
                    <td className="px-2 py-2"><button onClick={(event) => { event.stopPropagation(); void toggleSource(row.file) }} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${source?.file === row.file ? 'border-emerald-500 text-emerald-700' : 'border-zinc-300 text-zinc-500 hover:border-emerald-500 hover:text-emerald-700'}`}><FileCode2 size={11} />{source?.file === row.file ? t('verification.coverageDetail.closeSource') : t('verification.coverageDetail.viewSource')}</button></td>
                  </tr>
                  {open && <tr className="border-t border-zinc-100 bg-white"><td colSpan={5} className="px-2 py-2">
                    {row.points.length === 0 && <div className="py-2 text-center text-[11px] text-emerald-700">{t('verification.coverageDetail.coveredBadge')} ✓</div>}
                    {row.points.length > 0 && <table className="w-full table-fixed text-left text-[10px]">
                      <thead className="text-zinc-400"><tr>
                        <th className="w-14 px-1 py-1 font-medium">{t('verification.coverageDetail.colLine')}</th>
                        <th className="w-12 px-1 py-1 font-medium">{t('verification.coverageDetail.colColumn')}</th>
                        <th className="w-20 px-1 py-1 font-medium">{t('verification.coverageDetail.colKind')}</th>
                        <th className="w-28 px-1 py-1 font-medium">{t('verification.coverageDetail.colOrigin')}</th>
                        <th className="w-16 px-1 py-1 text-right font-medium">{t('verification.coverageDetail.colHits')}</th>
                        <th className="px-1 py-1 font-medium">{t('verification.coverageDetail.colHierarchy')}</th>
                      </tr></thead>
                      <tbody>{[...row.points].sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0)).map((point, index) => <tr key={index} className="border-t border-zinc-100">
                        <td className="px-1 py-1 font-mono text-zinc-600">{point.line}</td>
                        <td className="px-1 py-1 font-mono text-zinc-400">{point.column ?? '—'}</td>
                        <td className="px-1 py-1 text-zinc-500">{pointKindLabel(point.kind)}</td>
                        <td className="truncate px-1 py-1 font-mono text-zinc-500" title={point.origin}>{point.origin ?? '—'}</td>
                        <td className={`px-1 py-1 text-right font-mono font-semibold ${point.hits === 0 ? 'text-red-700' : 'text-emerald-700'}`}>{point.hits === 0 ? t('verification.coverageDetail.uncoveredBadge') : point.hits}</td>
                        <td className="truncate px-1 py-1 font-mono text-zinc-400" title={point.hierarchy}>{point.hierarchy ?? '—'}</td>
                      </tr>)}</tbody>
                    </table>}
                  </td></tr>}
                </Fragment>
              })}
            </tbody>
          </table>
        </div>}

        {/* 源码 gutter：行号 + 命中次数；有未覆盖点行红底、全部命中绿 gutter、无检测点灰 */}
        {source && ('error' in source
          ? <div className="mt-3 flex items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"><XCircle size={14} />{t('verification.coverageDetail.mapFailed')}<span className="font-mono text-[10px] text-amber-600">{source.file}</span></div>
          : <div className="mt-3 border border-zinc-200">
            <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11px] text-zinc-500"><FileCode2 size={12} className="text-emerald-600" /><span className="font-mono">{source.rel}</span>{source.truncated && <span className="text-amber-600">{t('verification.coverageDetail.truncated', { lines: sourceLines.length })}</span>}</div>
            <div className="max-h-96 overflow-auto">
              {sourceLines.map((line) => <div key={line.no} className={`flex font-mono text-[11px] leading-5 ${line.hasUncovered ? 'bg-red-50' : ''}`}>
                <span className={`w-16 shrink-0 select-none border-r pr-2 text-right ${line.hits.length === 0 ? 'text-zinc-300' : line.hasUncovered ? 'text-red-600' : 'bg-emerald-50 text-emerald-700'}`}>{line.no}</span>
                <span className={`w-20 shrink-0 select-none border-r px-2 text-right ${line.hits.length === 0 ? 'text-zinc-200' : line.hasUncovered ? 'font-semibold text-red-700' : 'bg-emerald-50 font-semibold text-emerald-700'}`}>{line.hits.length === 0 ? '·' : line.hits.reduce((sum, hit) => sum + hit, 0)}</span>
                <span className="whitespace-pre px-2 text-zinc-700">{line.text || ' '}</span>
              </div>)}
            </div>
          </div>)}
      </>}
    </>}
  </section>
}
