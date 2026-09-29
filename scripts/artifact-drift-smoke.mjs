import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PHASE_ORDER } from '../src/shared/types/moonglass.ts'
import { PHASE_ARTIFACT_PATHS, detectArtifactDrift, selectDownstreamResetTargets } from '../src/main/services/artifact-drift.ts'

// artifact-drift.ts 是零运行时依赖的纯函数模块，Node 原生类型剥除后直接导入验证。
const root = mkdtempSync(join(tmpdir(), 'moonglass-artifact-drift-'))
const writeDir = (rel) => mkdirSync(join(root, rel), { recursive: true })
const writeFile = (rel) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), 'x', 'utf-8')
}

const makePhaseState = (status) => ({
  status,
  deliverables: [],
  agentContext: { messageCount: 0 },
  reviewStatus: 'pending',
  gateCheckResults: []
})
const makePhases = (statuses) => Object.fromEntries(PHASE_ORDER.map((phase) => [phase, makePhaseState(statuses[phase] ?? 'locked')]))

try {
  // 1) 全部路径缺失 → 判漂移；条目按 PHASE_ORDER 产出，missingPaths 为完整映射
  {
    const phases = makePhases({ VERIF: 'completed', RTL: 'completed', SYNTH: 'active' })
    const entries = detectArtifactDrift(phases, root)
    assert.deepEqual(entries.map((entry) => entry.phase), ['RTL', 'VERIF'], '全部缺失的 completed 阶段判漂移，且按阶段顺序')
    assert.deepEqual(entries[0].missingPaths, [...PHASE_ARTIFACT_PATHS.RTL], 'RTL 漂移返回完整缺失路径（rtl + rtlqa/lint + rtlqa/cdc）')
    assert.deepEqual(entries[1].missingPaths, [...PHASE_ARTIFACT_PATHS.VERIF], 'VERIF 漂移返回完整缺失路径（docs/04_verification + verification）')
  }

  // 2) 部分存在不算漂移（进行中的删改是合法状态）
  {
    writeDir('verification')
    const phases = makePhases({ VERIF: 'completed' })
    assert.deepEqual(detectArtifactDrift(phases, root), [], 'VERIF 产物部分存在时不判漂移')
  }

  // 3) 非 completed 阶段不参与判定
  {
    writeDir('rtl')
    const phases = makePhases({ RTL: 'active' })
    assert.deepEqual(detectArtifactDrift(phases, root), [], 'active 阶段不判漂移')
  }

  // 4) 各阶段映射正确：补齐映射内全部路径后该阶段不再漂移
  {
    for (const phase of PHASE_ORDER) {
      for (const relPath of PHASE_ARTIFACT_PATHS[phase]) {
        if (relPath.includes('.')) writeFile(relPath)
        else writeDir(relPath)
      }
    }
    const phases = makePhases(Object.fromEntries(PHASE_ORDER.map((phase) => [phase, 'completed'])))
    assert.deepEqual(detectArtifactDrift(phases, root), [], 'REQ_SPEC/ARCH/RTL/VERIF/QA/SYNTH 映射全部命中磁盘时无漂移')
  }

  // 5) REQ_SPEC 映射含四份文档路径（含两个 .md 文件）
  {
    assert.deepEqual(
      [...PHASE_ARTIFACT_PATHS.REQ_SPEC],
      ['docs/01_project', 'docs/02_requirements', 'docs/03_design/interface_spec.md', 'docs/03_design/register_map.md'],
      'REQ_SPEC 映射与规格一致'
    )
    rmSync(join(root, 'docs/03_design/register_map.md'))
    const phases = makePhases({ REQ_SPEC: 'completed' })
    assert.deepEqual(detectArtifactDrift(phases, root), [], 'REQ_SPEC 仅缺一个文件（其余目录存在）不判漂移')
  }

  // 6) resetDownstream 纯计算：下游非 locked 阶段按顺序入选，locked 跳过，上游不参与
  {
    const phases = makePhases({ VERIF: 'completed', QA: 'skipped', SYNTH: 'blocked' })
    assert.deepEqual(selectDownstreamResetTargets(phases, 'RTL'), ['VERIF', 'QA', 'SYNTH'], 'RTL 重置目标：completed/skipped/blocked 下游全部入选')
    assert.deepEqual(selectDownstreamResetTargets(phases, 'VERIF'), ['QA', 'SYNTH'], 'VERIF 重置目标：QA + SYNTH')
    const withLocked = makePhases({ VERIF: 'locked', QA: 'completed' })
    assert.deepEqual(selectDownstreamResetTargets(withLocked, 'RTL'), ['QA'], 'locked 下游跳过')
    assert.deepEqual(selectDownstreamResetTargets(phases, 'SYNTH'), [], '最后阶段无下游')
  }

  console.log('\n✅ 阶段产物漂移对账冒烟全部通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
