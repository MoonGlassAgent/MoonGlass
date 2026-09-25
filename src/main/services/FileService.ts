/**
 * 项目文件服务
 *
 * 提供项目工作目录（pi 会话 cwd）的文件树扫描与文件读取，
 * 供工作区左侧文件树使用。所有路径限制在工作目录内，防目录穿越。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { FileContentResult, FileTreeNode, VerificationRunStatus } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import type { ProjectService } from './ProjectService'

/** 单文件读取上限（超出截断展示） */
const READ_MAX_BYTES = 256 * 1024
const JSON_MAX_BYTES = 16 * 1024 * 1024

/** 读取文本文件；失败时返回空串（供尽最大努力的扫描方法使用）。 */
function safeRead(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** 从 scenario evidence（如 "test_smoke.py::test_reset_sync_smoke"）提取测试函数名。 */
function extractTestName(evidence: string[]): string | null {
  for (const e of evidence) {
    const m = /::(test_\w+)/.exec(e)
    if (m) return m[1]
  }
  return null
}

/** 场景 ID → TEST ID：优先条目自带 testName，其次 evidence 中的 ::test_ 函数名，均经 nameToId 映射；
 * 无法映射时返回空串（不再造 TEST-<SCN十六进制> 幽灵 ID），由渲染端归入“未映射”区。 */
function mapScenarioToTestId(evidence: string[], nameToId: Map<string, { testId: string; module: string }>, testName?: string | null): string {
  if (testName && nameToId.has(testName)) return nameToId.get(testName)!.testId
  const viaEvidence = extractTestName(evidence)
  if (viaEvidence && nameToId.has(viaEvidence)) return nameToId.get(viaEvidence)!.testId
  return ''
}

/** 递归收集目录下的 Python 文件（跳过 __pycache__ 等产物目录）。 */
function listPyFilesRecursive(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch { return [] }
  const files: string[] = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '__pycache__') files.push(...listPyFilesRecursive(full))
    } else if (e.name.endsWith('.py')) {
      files.push(full)
    }
  }
  return files
}

/**
 * 从 cocotb 测试源码提取 test 函数 docstring 中的 TEST ID（放宽兜底）：
 * 允许 `-> 返回标注`、r 前缀与 ''' 引号、TEST ID 出现在 docstring 前 5 行内。
 */
function scanDocstringBindings(content: string): Array<{ testName: string; testId: string }> {
  const bindings: Array<{ testName: string; testId: string }> = []
  const lines = content.split(/\r?\n/)
  const defRe = /^\s*async\s+def\s+(test_\w+)\s*\([^)]*\)\s*(?:->\s*[^:]+)?\s*:/
  for (let i = 0; i < lines.length; i++) {
    const def = defRe.exec(lines[i])
    if (!def) continue
    // docstring 须是函数体第一条语句：def 后允许空行/注释，第一条有效语句以 """/'''（可带 r 前缀）开头
    let docStart = -1
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const trimmed = lines[j].trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (/^r?(?:"""|''')/.test(trimmed)) docStart = j
      break
    }
    if (docStart < 0) continue
    for (let j = docStart; j < Math.min(docStart + 5, lines.length); j++) {
      const id = /\b(TEST-[A-Z0-9-]+)\b/.exec(lines[j])
      if (id) {
        bindings.push({ testName: def[1], testId: id[1] })
        break
      }
    }
  }
  return bindings
}

/** test_plan.md 表头列名 → 语义列索引（中英文列名兼容）；TEST ID 列缺失时返回 null。 */
function mapTestPlanColumns(headerCells: string[]): { testId: number; tcId: number; priority: number; name: number; environment: number } | null {
  const normalized = headerCells.map((c) => c.trim().toLowerCase().replace(/\s+/g, ' '))
  const find = (names: string[], exclude = -1): number =>
    normalized.findIndex((c, idx) => idx !== exclude && c.length > 0 && names.some((n) => c === n || c.includes(n)))
  const testId = find(['test id', 'testid', '测试id', '用例id', '用例编号'])
  if (testId < 0) return null
  return {
    testId,
    tcId: find(['tc id', 'tcid', 'req', '需求', '追踪', 'trace'], testId),
    priority: find(['优先级', 'priority', 'prio'], testId),
    name: find(['用例名称', '名称', 'name', 'title', '测试目标', '目标', '描述', 'description', '用例'], testId),
    environment: find(['环境', 'environment', 'env', 'testbench'], testId)
  }
}

export class FileService implements MoonGlassService {
  readonly name = 'file-service'

  constructor(private readonly projects: ProjectService) {}

  start(): void {
    // 无常驻资源
  }

  stop(): void {
    // 无常驻资源
  }

  /** 扫描工作目录文件树（跳过隐藏项与 node_modules，目录在前按名称排序） */
  tree(projectId: string): FileTreeNode[] {
    const root = this.projects.workspaceDir(projectId)
    if (!existsSync(root)) return []
    return this.scanDir(root, root)
  }

  private scanDir(dir: string, root: string): FileTreeNode[] {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileTreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      const rel = full.slice(root.length + 1)
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, type: 'dir', children: this.scanDir(full, root) })
      } else {
        nodes.push({ name: e.name, path: rel, type: 'file' })
      }
    }
    return nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
    )
  }

  /** 读取文件内容（限制在工作目录内；二进制/超限做截断处理） */
  readFile(projectId: string, relPath: string): FileContentResult | null {
    const full = this.resolveProjectFile(projectId, relPath)
    if (!full) return null
    if (!existsSync(full) || !statSync(full).isFile()) return null

    const buf = readFileSync(full)
    // 含 NUL 字节视为二进制，不做文本展示
    if (buf.includes(0)) {
      return { content: '（二进制文件，暂不支持预览）', truncated: false }
    }
    const truncated = buf.length > READ_MAX_BYTES
    return { content: buf.subarray(0, READ_MAX_BYTES).toString('utf-8'), truncated }
  }

  /** 结构化视图专用：完整读取 JSON，不复用面向编辑器的 256 KiB 预览截断。 */
  readJson(projectId: string, relPath: string): unknown | null {
    if (!/\.json$/i.test(relPath)) throw new Error('结构化读取仅支持 JSON 文件')
    const full = this.resolveProjectFile(projectId, relPath)
    if (!full) return null
    const size = statSync(full).size
    if (size > JSON_MAX_BYTES) throw new Error(`JSON 文件超过结构化读取上限（${(size / 1024 / 1024).toFixed(1)} MB / 16 MB）`)
    try {
      return JSON.parse(readFileSync(full, 'utf-8')) as unknown
    } catch (error) {
      throw new Error(`JSON 数据无效：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 安全写入项目内文本文件；拒绝绝对路径和目录穿越。 */
  writeText(projectId: string, relPath: string, content: string): boolean {
    const root = resolve(this.projects.workspaceDir(projectId))
    const full = resolve(root, relPath)
    if (full === root || !full.startsWith(root + sep)) return false
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
    return true
  }

  /** 将项目相对路径安全解析为绝对文件路径，拒绝目录穿越与不存在的文件。 */
  resolveProjectFile(projectId: string, relPath: string): string | null {
    const root = resolve(this.projects.workspaceDir(projectId))
    const full = resolve(root, relPath)
    if (full !== root && !full.startsWith(root + sep)) return null
    if (!existsSync(full) || !statSync(full).isFile()) return null
    return full
  }

  /**
   * 验证环境与用例执行状态（操作级视图）。
   *
   * 数据源：
   * - 环境：verification/<module>_tb/（含 tests/ 或 env/ 视为已搭建）
   * - 规划用例：docs/04_verification/test_plan.md 的 TEST-* 表格（表头感知解析；
   *   缺标准表头时回退固定位置序并带 headerWarning）；缺失时回退到测试文件函数清单
   * - 执行结果：verification/results/<module>/scenario_hits.json（累计权威证据）
   *   与 results_*.xml（JUnit，按 mtime 取最新，补充用例）
   * - testName → TEST ID 映射：首选 verification/<module>_tb/test_manifest.json
   *   显式登记，兜底解析 tests/（递归）测试函数 docstring 前 5 行内的 TEST ID
   *
   * 该方法只读不写、尽最大努力返回，不因单文件损坏而整体抛错。
   */
  verificationRunStatus(projectId: string): VerificationRunStatus {
    const root = resolve(this.projects.workspaceDir(projectId))
    const status: VerificationRunStatus = {
      environment: { ready: false, testbenches: [], missing: [] },
      planned: [],
      executed: [],
      summary: { planned: 0, executed: 0, passed: 0, failed: 0, skipped: 0, notRun: 0, bugsFound: 0 }
    }
    if (!existsSync(root)) return status

    const listDirs = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch { return [] }
    }
    const listFiles = (dir: string): string[] => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
      } catch { return [] }
    }

    const verificationDir = join(root, 'verification')

    // ── 1. 验证环境 ──────────────────────────────────────────
    const tbDirs = existsSync(verificationDir) ? listDirs(verificationDir).filter((d) => /_tb$/.test(d)) : []
    for (const tb of tbDirs) {
      const tbPath = join(verificationDir, tb)
      if (existsSync(join(tbPath, 'tests')) || existsSync(join(tbPath, 'env'))) {
        status.environment.testbenches.push(tb)
      }
    }
    status.environment.ready = status.environment.testbenches.length > 0
    if (!existsSync(verificationDir)) {
      status.environment.missing.push('尚未创建 verification/ 目录')
    } else if (!status.environment.ready) {
      status.environment.missing.push('尚未搭建 Cocotb 验证环境（需要 verification/<module>_tb/tests 与 env）')
    }

    // ── 2. testName → TEST ID 映射 ───────────────────────────
    // 首选 verification/<tb>/test_manifest.json（显式登记，存在时以它为准）；
    // 兜底解析 tests/ 下（递归）测试函数 docstring 中的 TEST ID。
    const nameToId = new Map<string, { testId: string; module: string }>()
    for (const tb of status.environment.testbenches) {
      const testsDir = join(verificationDir, tb, 'tests')
      if (existsSync(testsDir)) {
        for (const filePath of listPyFilesRecursive(testsDir)) {
          for (const binding of scanDocstringBindings(safeRead(filePath))) {
            nameToId.set(binding.testName, { testId: binding.testId, module: tb })
          }
        }
      }
      const manifestPath = join(verificationDir, tb, 'test_manifest.json')
      if (!existsSync(manifestPath)) continue
      try {
        // manifest 格式：{ "<test函数名>": { "testId": "TEST-...", "scenarios": ["SCN-..."] } }
        const manifest = JSON.parse(safeRead(manifestPath)) as Record<string, { testId?: string }>
        for (const [testName, entry] of Object.entries(manifest)) {
          if (typeof entry?.testId === 'string' && /^TEST-[A-Z0-9-]+$/.test(entry.testId)) {
            nameToId.set(testName, { testId: entry.testId, module: tb })
          }
        }
      } catch { /* 损坏的 manifest 忽略，回退 docstring 扫描结果 */ }
    }

    // ── 3. 规划用例：test_plan.md 表格（表头感知解析） ────────
    // 先找含 TEST ID 列名的表头行并按列名映射（中英文列名兼容）；找不到标准表头时
    // 回退旧的固定位置序解析（兼容旧工作区），并带 headerWarning 提示渲染端展示。
    const testPlanPath = join(root, 'docs', '04_verification', 'test_plan.md')
    if (existsSync(testPlanPath)) {
      const planLines = safeRead(testPlanPath).split(/\r?\n/)
      let columns: ReturnType<typeof mapTestPlanColumns> | null = null
      for (const line of planLines) {
        if (!line.includes('|')) continue
        const cells = line.split('|').map((c) => c.trim())
        if (!columns) {
          columns = mapTestPlanColumns(cells)
          if (columns) continue
          // 兼容兜底：固定位置序（| TEST ID | TC | 优先级 | 名称 | 环境 |）。
          // 要求 5 个数据列（cells.length ≥ 7，含首尾空串）：更短的行（如无表头的 4 列行）
          // 按旧逻辑会被误当计划行导致列错位，改为丢弃并依赖 headerWarning 提示。
          if (!line.includes('TEST-') || cells.length < 7) continue
          const testId = cells[1] ?? ''
          if (!/^TEST-[A-Z0-9-]+$/.test(testId)) continue
          status.planned.push({ testId, tcId: cells[2] ?? '', priority: cells[3] ?? '', name: cells[4] ?? '', environment: cells[5] ?? '' })
        } else {
          const testId = cells[columns.testId] ?? ''
          if (!/^TEST-[A-Z0-9-]+$/.test(testId)) continue
          const cell = (idx: number): string => (idx >= 0 ? cells[idx] ?? '' : '')
          status.planned.push({
            testId,
            tcId: cell(columns.tcId),
            priority: cell(columns.priority),
            name: cell(columns.name),
            environment: cell(columns.environment)
          })
        }
      }
      if (!columns && planLines.some((line) => line.includes('TEST-'))) {
        status.headerWarning = 'test_plan.md 缺少标准表头（期望首列 TEST ID），已按固定列序兼容解析；建议补齐表头以避免列错位。未映射 = 用例已在计划文档登记，但还没绑定到任何验证点（SCN/VI）；可在 test_plan.md 中补充 SCN 绑定，或让 Agent 补绑'
      }
    }
    // 回退：无 test_plan.md 时，以测试文件中的函数清单作为规划用例
    if (status.planned.length === 0 && nameToId.size > 0) {
      for (const [testName, mapped] of nameToId) {
        status.planned.push({ testId: mapped.testId, tcId: '', priority: '', name: testName, environment: mapped.module })
      }
    }

    // ── 4. 执行证据：scenario_hits.json（累计，优先）+ JUnit XML（多份，按 mtime 取最新，补充）──
    // 注意：单用例调试运行时其余用例在 JUnit 中显示 <skipped/>；若只读 JUnit 会把历史
    // PASS 误报为“未执行”。scenario_hits.json 是跨多次运行累计的权威证据，应作为
    // PASS/FAIL 的首要来源；JUnit 按 testModule 分文件存放，同一 testId 取 mtime 最新者。
    const resultsDir = join(verificationDir, 'results')
    if (existsSync(resultsDir)) {
      const executedByTestId = new Map<string, VerificationRunStatus['executed'][number]>()
      // 4a. 累计证据 scenario_hits.json
      for (const moduleDir of listDirs(resultsDir)) {
        const modulePath = join(resultsDir, moduleDir)
        const hitsPath = join(modulePath, 'scenario_hits.json')
        if (!existsSync(hitsPath)) continue
        try {
          const hits = JSON.parse(safeRead(hitsPath)) as { scenarios?: Array<Record<string, unknown>> }
          for (const sc of hits.scenarios ?? []) {
            const id = String(sc.id ?? '')
            if (!id) continue
            const evidence = (sc.evidence as string[] | undefined) ?? []
            // 条目自带 testName（run_simulation 从 JUnit 解析写入）优先，兼容旧数据的 evidence 解析
            const hitTestName = typeof sc.testName === 'string' && sc.testName ? sc.testName : null
            const testId = mapScenarioToTestId(evidence, nameToId, hitTestName)
            const passed = sc.passed === true
            const blocker = String(sc.blocker ?? '')
            const isFail = !passed && (sc.reached === true || blocker.length > 0)
            // testId 为空时用场景 ID 作 key，避免多条未映射记录互相覆盖
            executedByTestId.set(testId || `scenario:${id}`, {
              testId,
              testName: hitTestName ?? extractTestName(evidence) ?? '',
              module: moduleDir,
              status: passed ? 'PASS' : isFail ? 'FAIL' : 'SKIPPED',
              bugFound: isFail,
              errorMessage: String(sc.disposition ?? sc.blocker ?? '') || undefined,
              blocker: blocker || undefined
            })
          }
        } catch { /* 忽略损坏的 scenario_hits.json */ }
      }
      // 4b. JUnit XML（补充累计证据未覆盖的用例与最新瞬时错误；同一 testId 多份时按 mtime 取最新，
      // 兼容旧的 results_<simulator>.xml 单文件命名）
      const junitKeys = new Set<string>()
      for (const moduleDir of listDirs(resultsDir)) {
        const modulePath = join(resultsDir, moduleDir)
        const xmlFiles = listFiles(modulePath)
          .filter((file) => /^results_.*\.xml$/.test(file))
          .map((file) => {
            let mtime = 0
            try { mtime = statSync(join(modulePath, file)).mtimeMs } catch { /* 并发删除时按最旧处理 */ }
            return { file, mtime }
          })
          .sort((a, b) => a.mtime - b.mtime)
        for (const { file } of xmlFiles) {
          const content = safeRead(join(modulePath, file))
          const caseRe = /<testcase\s+([^>]*?)(?:\/>|>(.*?)<\/testcase>)/gs
          let m: RegExpExecArray | null
          while ((m = caseRe.exec(content)) !== null) {
            const attrs = m[1] ?? ''
            const body = m[2] ?? ''
            const name = /name="([^"]+)"/.exec(attrs)?.[1] ?? ''
            if (!name) continue
            const timeSec = Number(/time="([^"]+)"/.exec(attrs)?.[1] ?? 0)
            const skipped = /<skipped\s*\/?>/.test(body)
            const failed = /<(?:failure|error)\b/.test(body)
            const errorMessage = /error_msg="([^"]*)"/.exec(body)?.[1] ?? ''
            const mapped = nameToId.get(name)
            const testId = mapped?.testId ?? ''
            const key = testId || `junit:${name}`
            const existing = executedByTestId.get(key)
            if (existing && !junitKeys.has(key)) {
              // 已有累计证据：仅在累计未给出根因时补充本次 JUnit 的瞬时错误详情
              if (!existing.errorMessage && failed) existing.errorMessage = errorMessage
              continue
            }
            // 同源 JUnit 条目：文件按 mtime 升序处理，后处理的（更新的）覆盖旧结果
            junitKeys.add(key)
            executedByTestId.set(key, {
              testId,
              testName: name,
              module: mapped?.module ?? moduleDir,
              status: skipped ? 'SKIPPED' : failed ? 'FAIL' : 'PASS',
              bugFound: failed,
              errorMessage: errorMessage || undefined,
              timeSec: Number.isFinite(timeSec) ? timeSec : undefined
            })
          }
        }
      }
      status.executed = [...executedByTestId.values()]
    }

    // ── 5. 汇总 ──────────────────────────────────────────────
    const runTestIds = new Set(status.executed.filter((e) => e.status === 'PASS' || e.status === 'FAIL').map((e) => e.testId).filter(Boolean))
    status.summary.planned = status.planned.length
    status.summary.executed = status.executed.filter((e) => e.status === 'PASS' || e.status === 'FAIL').length
    status.summary.passed = status.executed.filter((e) => e.status === 'PASS').length
    status.summary.failed = status.executed.filter((e) => e.status === 'FAIL').length
    status.summary.skipped = status.executed.filter((e) => e.status === 'SKIPPED').length
    status.summary.bugsFound = status.executed.filter((e) => e.bugFound).length
    status.summary.notRun = status.planned.filter((p) => !runTestIds.has(p.testId)).length
    return status
  }
}
