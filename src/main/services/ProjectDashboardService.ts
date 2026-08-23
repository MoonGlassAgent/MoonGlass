import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { PHASE_ORDER, type ChipProject, type Phase } from '@shared/types'

export interface DashboardResult {
  path: string
  generatedAt: string
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function collectFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectFiles(full, pattern))
    else if (pattern.test(entry.name)) out.push(full)
  }
  return out
}

function readOptional(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : ''
}

function metric(label: string, value: unknown, note = ''): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</div>`
}

function extractMarkdownValue(content: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)\\s*[-|]?\\s*${escaped}\\s*[：:|]\\s*([^|\\n]+)`, 'i')
    .exec(content)?.[1]?.trim().replaceAll('`', '')
}

function latestFile(files: string[]): string | undefined {
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function phaseStatus(project: ChipProject, phase: Phase): string {
  const status = project.phases[phase].status
  return status === 'completed' ? '完成' : status === 'skipped' ? '跳过' : status === 'active' ? '进行中' : '未开始'
}

function relativeList(workspaceDir: string, files: string[], limit = 80): string[] {
  return files.slice(0, limit).map((file) => relative(workspaceDir, file).replaceAll('\\', '/'))
}

function listItems(items: string[], empty = '暂无记录'): string {
  return items.length > 0 ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : `<p class="muted">${escapeHtml(empty)}</p>`
}

export function generateProjectDashboard(project: ChipProject, workspaceDir: string): DashboardResult {
  const generatedAt = new Date().toISOString()
  const rtlFiles = collectFiles(join(workspaceDir, 'rtl'), /\.(v|sv)$/i)
  let rtlLines = 0
  const modules = new Set<string>()
  for (const file of rtlFiles) {
    const code = readFileSync(file, 'utf-8')
    rtlLines += code.split(/\r?\n/).length
    for (const match of code.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g)) modules.add(match[1])
  }

  const requirements = readOptional(join(workspaceDir, 'docs', '02_requirements', 'product_requirements.md'))
  const specRows = [
    ['目标工艺', project.targetProcess ?? extractMarkdownValue(requirements, '目标工艺') ?? '未定义'],
    ['目标频率', project.targetFrequency ? `${project.targetFrequency} MHz` : extractMarkdownValue(requirements, '目标频率') ?? '未定义'],
    ['目标面积', project.targetArea ?? extractMarkdownValue(requirements, '目标面积') ?? '未定义'],
    ['目标功耗', project.targetPower ?? extractMarkdownValue(requirements, '目标功耗') ?? '未定义'],
    ['EDA 工具链', project.edaToolchain]
  ]

  const resultFiles = collectFiles(join(workspaceDir, 'verification', 'results'), /^result\.json$/i)
  let passedRuns = 0
  let failedRuns = 0
  let lineCoverage: number | undefined
  let branchCoverage: number | undefined
  let toggleCoverage: number | undefined
  let functionalCoverage: number | undefined
  const verificationRuns: Array<{ path: string; passed: boolean; tests: string; simulator: string }> = []
  for (const file of resultFiles) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      if (data.passed === true) passedRuns++
      else failedRuns++
      const coverage = (data.coverage ?? {}) as Record<string, unknown>
      const line = data.lineCoverage ?? data.line_coverage ?? coverage.lineCoverage ?? coverage.line_coverage
      const functional = data.functionalCoverage ?? data.functional_coverage ??
        coverage.functionalCoverage ?? coverage.functional_coverage
      const branch = data.branchCoverage ?? data.branch_coverage ?? coverage.branchCoverage ?? coverage.branch_coverage
      const toggle = data.toggleCoverage ?? data.toggle_coverage ?? coverage.toggleCoverage ?? coverage.toggle_coverage
      if (typeof line === 'number') lineCoverage = Math.max(lineCoverage ?? 0, line)
      if (typeof branch === 'number') branchCoverage = Math.max(branchCoverage ?? 0, branch)
      if (typeof toggle === 'number') toggleCoverage = Math.max(toggleCoverage ?? 0, toggle)
      if (typeof functional === 'number') functionalCoverage = Math.max(functionalCoverage ?? 0, functional)
      verificationRuns.push({ path: relative(workspaceDir, file).replaceAll('\\', '/'), passed: data.passed === true, tests: `${Number(data.testsPassed ?? 0)}/${Number(data.testsTotal ?? 0)}`, simulator: String(data.simulator ?? data.framework ?? '未记录') })
    } catch {
      failedRuns++
    }
  }
  const waveforms = collectFiles(join(workspaceDir, 'verification', 'results'), /\.(vcd|fst)$/i)
  const documents = collectFiles(join(workspaceDir, 'docs'), /\.(md|html|pdf)$/i)
  const reports = collectFiles(workspaceDir, /(?:report|review|signoff|issue|coverage).*(?:\.md|\.html|\.json|\.xml)$/i)
    .filter((file) => !file.endsWith('project_dashboard.html'))
  const gateRows = PHASE_ORDER.flatMap((phase) => project.phases[phase].gateCheckResults.map((gate) => ({ phase, gate })))
  const failedGates = gateRows.filter(({ gate }) => !gate.passed)
  const changeNotices = PHASE_ORDER.flatMap((phase) => project.phases[phase].changeNotice?.status === 'pending' ? [`${phase}：存在尚未响应的上游变更`] : [])
  const skippedPhases = PHASE_ORDER.filter((phase) => project.phases[phase].status === 'skipped')

  const synthesisReportPath = latestFile(
    collectFiles(join(workspaceDir, 'imp', 'synthesis'), /_synthesis\.md$/i)
  )
  const synthesisReport = synthesisReportPath ? readFileSync(synthesisReportPath, 'utf-8') : ''
  const synthesis = {
    top: extractMarkdownValue(synthesisReport, '顶层模块') ?? '暂无',
    cells: extractMarkdownValue(synthesisReport, '单元数量') ?? '暂无',
    area: extractMarkdownValue(synthesisReport, '映射面积') ?? '暂无',
    delay: extractMarkdownValue(synthesisReport, '估算延迟') ?? '暂无',
    slack: extractMarkdownValue(synthesisReport, '估算 Slack') ?? '暂无',
    report: synthesisReportPath ? relative(workspaceDir, synthesisReportPath) : '暂无'
  }

  const resolvedPhases = (Object.keys(project.phases) as Phase[])
    .filter((phase) => ['completed', 'skipped'].includes(project.phases[phase].status)).length
  const completed = project.phases.SYNTH.status === 'completed'
  const outputDir = join(workspaceDir, 'docs', '07_release')
  const outputPath = join(outputDir, 'project_dashboard.html')
  mkdirSync(outputDir, { recursive: true })

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(project.name)} · 项目看板</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f4f5;color:#18181b;font:14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}
header{background:#18181b;color:#fff;padding:28px max(24px,calc((100% - 1180px)/2));border-bottom:4px solid #2563eb}
header h1{margin:0;font-size:28px;letter-spacing:0}header p{margin:5px 0 0;color:#d4d4d8}
main{max-width:1180px;margin:0 auto;padding:24px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.metric{min-height:96px;background:#fff;border:1px solid #d4d4d8;border-radius:6px;padding:14px}.metric span,.metric small{display:block;color:#71717a}
.metric strong{display:block;margin:5px 0;font-size:23px}.band{margin:0 -24px;padding:22px 24px;border-top:1px solid #d4d4d8}
.band:nth-child(even){background:#fff}h2{margin:0 0 14px;font-size:18px}table{width:100%;border-collapse:collapse;background:#fff}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e4e4e7}th{color:#52525b;background:#fafafa}
.phase-row{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}.phase{padding:10px 6px;border:1px solid #d4d4d8;border-radius:5px;text-align:center}
.completed{border-color:#10b981;background:#ecfdf5;color:#047857}.skipped{border-color:#f59e0b;background:#fffbeb;color:#b45309}
.active{border-color:#3b82f6;background:#eff6ff;color:#1d4ed8}.muted{color:#71717a}.notice{padding:10px;border-left:3px solid #f59e0b;background:#fffbeb}
.ok{color:#047857}.bad{color:#b91c1c}ul{margin:8px 0;padding-left:22px}.compact td{font-size:13px;vertical-align:top}.wide{overflow-x:auto}.meta{display:flex;gap:18px;flex-wrap:wrap;color:#d4d4d8;font-size:12px}
footer{max-width:1180px;margin:0 auto;padding:18px 24px 28px;color:#71717a}@media(max-width:760px){.summary{grid-template-columns:1fr 1fr}.phase-row{grid-template-columns:1fr}.band{margin:0}}
</style></head><body>
<header><h1>${escapeHtml(project.name)} · 总体报告</h1><p>${escapeHtml(project.description ?? '未填写项目描述')} · ${completed ? '项目完成' : '项目进行中'}</p><div class="meta"><span>项目 ID：${escapeHtml(project.id)}</span><span>当前阶段：${escapeHtml(project.currentPhase)}</span><span>工作目录：${escapeHtml(workspaceDir)}</span></div></header>
<main>
<section class="summary">
${metric('项目进度', `${resolvedPhases}/${PHASE_ORDER.length}`, completed ? '已完成' : `当前 ${project.currentPhase}`)}
${metric('RTL 规模', `${rtlLines.toLocaleString()} 行`, `${rtlFiles.length} 文件 / ${modules.size} 模块`)}
${metric('验证运行', resultFiles.length, `${passedRuns} 通过 / ${failedRuns} 失败`)}
${metric('综合单元', synthesis.cells, synthesis.area === '暂无' ? '无工艺映射面积' : `面积 ${synthesis.area}`)}
</section>
<section class="band"><h2>阶段状态</h2><div class="phase-row">
${PHASE_ORDER.map((phase) => `<div class="phase ${project.phases[phase].status}"><strong>${phase}</strong><br>${phaseStatus(project, phase)}</div>`).join('')}
</div></section>
<section class="band"><h2>执行摘要</h2><p>本报告依据 MoonGlass 项目状态和工作区现有证据自动生成。当前完成 ${resolvedPhases}/${PHASE_ORDER.length} 个阶段，识别 ${rtlFiles.length} 个 RTL 文件、${resultFiles.length} 次验证结果和 ${documents.length} 份项目文档。</p>
${failedGates.length > 0 || changeNotices.length > 0 || skippedPhases.length > 0 ? `<div class="notice"><strong>需要关注</strong>${listItems([...failedGates.map(({ phase, gate }) => `${phase} 门禁未通过：${gate.name}${gate.detail ? ` - ${gate.detail}` : ''}`), ...changeNotices, ...skippedPhases.map((phase) => `${phase} 阶段已跳过`)])}</div>` : '<p class="ok">当前项目状态中未发现未通过门禁、待响应变更或跳过阶段。</p>'}</section>
<section class="band"><h2>核心规格</h2><table><tbody>${specRows.map(([key,value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</tbody></table></section>
<section class="band"><h2>项目规模</h2><div class="summary">
${metric('RTL 文件', rtlFiles.length)}${metric('RTL 模块', modules.size)}${metric('代码行', rtlLines.toLocaleString())}${metric('顶层综合模块', synthesis.top)}
</div><p class="muted">模块：${escapeHtml([...modules].join('、') || '暂无')}</p></section>
<section class="band"><h2>验证情况</h2><div class="summary">
${metric('结果文件', resultFiles.length)}${metric('通过', passedRuns)}${metric('失败', failedRuns)}${metric('波形', waveforms.length)}
</div><table><tbody><tr><th>行覆盖率</th><td>${lineCoverage === undefined ? '暂无' : `${lineCoverage}%`}</td></tr>
<tr><th>条件/分支覆盖率</th><td>${branchCoverage === undefined ? '暂无' : `${branchCoverage}%`}</td></tr>
<tr><th>翻转覆盖率</th><td>${toggleCoverage === undefined ? '暂无' : `${toggleCoverage}%`}</td></tr>
<tr><th>功能覆盖率</th><td>${functionalCoverage === undefined ? '暂无' : `${functionalCoverage}%`}</td></tr>
<tr><th>阶段状态</th><td>${escapeHtml(phaseStatus(project, 'VERIF'))}</td></tr></tbody></table>
${project.phases.VERIF.status === 'skipped' ? '<p class="notice">验证阶段已由用户跳过，本报告不代表功能验证通过。</p>' : ''}</section>
<section class="band"><h2>验证运行明细</h2><div class="wide"><table class="compact"><thead><tr><th>结果</th><th>测试通过/总数</th><th>仿真器</th><th>证据文件</th></tr></thead><tbody>
${verificationRuns.length > 0 ? verificationRuns.map((run) => `<tr><td class="${run.passed ? 'ok' : 'bad'}">${run.passed ? '通过' : '失败'}</td><td>${escapeHtml(run.tests)}</td><td>${escapeHtml(run.simulator)}</td><td>${escapeHtml(run.path)}</td></tr>`).join('') : '<tr><td colspan="4" class="muted">暂无结构化验证结果</td></tr>'}
</tbody></table></div></section>
<section class="band"><h2>质量门禁与阶段交付</h2><div class="wide"><table class="compact"><thead><tr><th>阶段</th><th>状态</th><th>Review</th><th>门禁</th><th>交付物</th></tr></thead><tbody>
${PHASE_ORDER.map((phase) => { const state = project.phases[phase]; const gates = state.gateCheckResults.length > 0 ? state.gateCheckResults.map((gate) => `${gate.passed ? '✓' : '✗'} ${gate.name}`).join('；') : '未执行'; const deliverables = state.deliverables.length > 0 ? state.deliverables.join('；') : '未登记'; return `<tr><td>${phase}</td><td>${phaseStatus(project, phase)}</td><td>${escapeHtml(state.reviewStatus)}</td><td>${escapeHtml(gates)}</td><td>${escapeHtml(deliverables)}</td></tr>` }).join('')}
</tbody></table></div></section>
<section class="band"><h2>综合报告摘要</h2><table><tbody>
<tr><th>顶层模块</th><td>${escapeHtml(synthesis.top)}</td></tr><tr><th>单元数量</th><td>${escapeHtml(synthesis.cells)}</td></tr>
<tr><th>映射面积</th><td>${escapeHtml(synthesis.area)}</td></tr><tr><th>估算延迟</th><td>${escapeHtml(synthesis.delay)}</td></tr>
<tr><th>估算 Slack</th><td>${escapeHtml(synthesis.slack)}</td></tr><tr><th>原始报告</th><td>${escapeHtml(synthesis.report)}</td></tr>
</tbody></table></section>
<section class="band"><h2>文档与质量证据索引</h2><div class="summary">${metric('项目文档', documents.length)}${metric('质量/报告文件', reports.length)}${metric('验证波形', waveforms.length)}${metric('待处理风险', failedGates.length + changeNotices.length)}</div><h3>主要文档</h3>${listItems(relativeList(workspaceDir, documents), '未找到项目文档')}<h3>报告与 Review 证据</h3>${listItems(relativeList(workspaceDir, reports), '未找到报告或 Review 证据')}</section>
<section class="band"><h2>结论与交付声明</h2><p>${completed && failedGates.length === 0 && changeNotices.length === 0 ? '项目流程状态已完成，且项目状态中没有未通过门禁或待响应变更。正式交付前仍应由负责人确认签核报告、工艺库版本、回归范围和已知限制。' : '项目尚不满足无条件交付声明。请处理未完成阶段、失败门禁、待响应变更和缺失证据后重新生成本报告。'}</p><p class="muted">本报告是工程证据汇总，不替代设计、验证、质量或综合负责人的正式签核。</p></section>
</main><footer>生成时间：${escapeHtml(new Date(generatedAt).toLocaleString('zh-CN'))} · MoonGlass 项目看板 · ${escapeHtml(basename(outputPath))}</footer>
</body></html>`
  writeFileSync(outputPath, html, 'utf-8')
  return { path: outputPath, generatedAt }
}
