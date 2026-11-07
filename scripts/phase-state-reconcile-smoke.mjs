import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PHASE_ORDER } from '../src/shared/types/moonglass.ts'
import {
  countPhaseSessionMessages,
  discoverPhaseArtifacts,
  phaseMainSessionName,
  reconcilePhaseState,
  reconcileProjectPhases,
  sessionBelongsToPhase
} from '../src/main/services/artifact-drift.ts'

// 阶段状态对账（MG-046）冒烟：deliverables/messageCount 运行期从不写入，
// reconcilePhaseState/reconcileProjectPhases 按磁盘事实回填校正。
// artifact-drift.ts 保持零外部依赖，Node 原生类型剥除后直接导入验证。

const root = mkdtempSync(join(tmpdir(), 'moonglass-phase-reconcile-'))
const workspace = join(root, 'workspace')
const sessionDir = join(root, 'pi-sessions', 'p1')
const writeRel = (base, rel, content = 'x') => {
  const path = join(base, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  return path
}
const messageLine = (role) => JSON.stringify({ type: 'message', message: { role, content: 'hi' } })
const freshState = () => ({
  status: 'active',
  deliverables: [],
  agentContext: { messageCount: 0 },
  reviewStatus: 'pending',
  gateCheckResults: []
})

try {
  // ---------- 1) 会话归属口径与 AgentService 一致（前缀边界） ----------
  assert.equal(phaseMainSessionName('REQ_SPEC'), 'phase-req_spec', 'REQ_SPEC 主会话逻辑名')
  assert.equal(phaseMainSessionName('VERIF'), 'phase-verif', 'VERIF 主会话逻辑名')
  assert.ok(sessionBelongsToPhase('phase-req_spec', 'REQ_SPEC'), '主会话归属本阶段')
  assert.ok(sessionBelongsToPhase('phase-req_spec--task-1', 'REQ_SPEC'), '平行会话归属本阶段')
  assert.ok(!sessionBelongsToPhase('phase-req', 'REQ_SPEC'), 'phase-req 不归 REQ_SPEC（前缀边界）')
  assert.ok(!sessionBelongsToPhase('phase-req_specx', 'REQ_SPEC'), 'phase-req_specx 不归 REQ_SPEC（前缀边界）')
  assert.ok(!sessionBelongsToPhase('phase-arch--review', 'REQ_SPEC'), '其他阶段平行会话不归属')

  // ---------- 2) 消息统计：按真实会话 JSONL 计，排除 .bak/archive/旧版主会话/其他阶段 ----------
  const stampMs = Date.parse('2026-10-29T08:00:00.000Z')
  writeRel(sessionDir, 'session-phase-req_spec.jsonl', [
    messageLine('user'),
    messageLine('assistant'),
    JSON.stringify({ type: 'session_info', name: 'REQ 主会话' }),
    messageLine('user'),
    '{broken-line-not-json'
  ].join('\n') + '\n')
  writeRel(sessionDir, 'session-phase-req_spec--task-1.jsonl', `${messageLine('user')}\n${messageLine('assistant')}\n`)
  writeRel(sessionDir, 'session-phase-arch.jsonl', `${messageLine('user')}\n${messageLine('user')}\n${messageLine('user')}\n${messageLine('user')}\n${messageLine('user')}\n`)
  writeRel(sessionDir, 'session.jsonl', `${messageLine('user')}\n${messageLine('user')}\n${messageLine('user')}\n${messageLine('user')}\n`)
  writeRel(sessionDir, 'session-phase-req_spec.bak.jsonl', `${messageLine('user')}\n`)
  writeRel(sessionDir, 'archive/session-phase-req_spec-old.jsonl', `${messageLine('user')}\n${messageLine('user')}\n`)
  const olderMs = Date.parse('2026-10-28T08:00:00.000Z')
  utimesSync(join(sessionDir, 'session-phase-req_spec.jsonl'), new Date(olderMs), new Date(olderMs))
  utimesSync(join(sessionDir, 'session-phase-req_spec--task-1.jsonl'), new Date(stampMs), new Date(stampMs))

  const reqStats = countPhaseSessionMessages(sessionDir, 'REQ_SPEC')
  assert.equal(reqStats.messageCount, 5, 'REQ_SPEC：主会话 3 条 + 平行会话 2 条；session_info/坏行/.bak/archive/session.jsonl 不计')
  assert.equal(reqStats.lastActiveAt, new Date(stampMs).toISOString(), 'lastActiveAt 取归属会话的最新 mtime')
  assert.equal(countPhaseSessionMessages(sessionDir, 'ARCH').messageCount, 5, 'ARCH 只统计自己的会话')
  assert.equal(countPhaseSessionMessages(join(root, 'no-such-dir'), 'REQ_SPEC').messageCount, 0, '会话目录不存在按 0 处理')

  // 追加消息后计数随磁盘事实增长（mtime+size 缓存失效重读）
  const mainSession = join(sessionDir, 'session-phase-req_spec.jsonl')
  writeFileSync(mainSession, `${messageLine('assistant')}\n`, { flag: 'a' })
  assert.equal(countPhaseSessionMessages(sessionDir, 'REQ_SPEC').messageCount, 6, '追加一条消息后计数 +1')

  // ---------- 3) 产物发现：目录递归 + 映射文件 + 噪音过滤 + 稳定排序 ----------
  writeRel(workspace, 'docs/01_project/overview.md')
  writeRel(workspace, 'docs/02_requirements/product_requirements.md')
  writeRel(workspace, 'docs/02_requirements/requirements_traceability.md')
  writeRel(workspace, 'docs/03_design/interface_spec.md')
  writeRel(workspace, 'docs/03_design/register_map.md')
  writeRel(workspace, 'docs/03_design/architecture.md')
  writeRel(workspace, 'rtl/top.v')
  writeRel(workspace, 'rtl/macros/sram_bb.v')
  writeRel(workspace, 'verification/results/tiny/result.json', JSON.stringify({ passed: true }))
  writeRel(workspace, 'verification/tiny_tb/build/junk.v', 'module junk; endmodule')
  writeRel(workspace, 'verification/tiny_tb/sim/waves.vcd', 'vcd')
  writeRel(workspace, '.moonglass/phase-archives/RTL/stamp/rtl/top.v', 'archived')
  const reqFound = discoverPhaseArtifacts(workspace, 'REQ_SPEC')
  assert.deepEqual(reqFound, [
    'docs/01_project/overview.md',
    'docs/02_requirements/product_requirements.md',
    'docs/02_requirements/requirements_traceability.md',
    'docs/03_design/interface_spec.md',
    'docs/03_design/register_map.md'
  ], 'REQ_SPEC 发现映射内全部产物；architecture.md 属 ARCH 映射，不在此列')
  const rtlFound = discoverPhaseArtifacts(workspace, 'RTL')
  assert.deepEqual(rtlFound, ['rtl/macros/sram_bb.v', 'rtl/top.v'], 'RTL 发现 rtl/ 内文件；.moonglass 归档产物不参与')
  const verifFound = discoverPhaseArtifacts(workspace, 'VERIF')
  assert.deepEqual(verifFound, ['verification/results/tiny/result.json'], 'VERIF 过滤 build/ 与 .vcd 中间产物')
  assert.deepEqual(discoverPhaseArtifacts(workspace, 'SYNTH'), [], 'SYNTH 无映射产物')

  // 上限截断：105 个 RTL 文件只登记前 100 个（排序稳定）
  for (let index = 0; index < 105; index += 1) {
    writeRel(workspace, `rtl/many/m${String(index).padStart(3, '0')}.v`)
  }
  const capped = discoverPhaseArtifacts(workspace, 'RTL')
  assert.equal(capped.length, 100, '单阶段交付物发现截断到 100')
  assert.deepEqual(capped, [...capped].sort(), '截断前已稳定排序')

  // ---------- 4) 空状态 + 有产物 → 回填；status/gates 不写；幂等 ----------
  {
    const state = freshState()
    const next = reconcilePhaseState({ phase: 'REQ_SPEC', state, workspaceDir: workspace, sessionDir })
    assert.ok(next, '空记录 + 磁盘产物应触发回填')
    assert.equal(next.deliverables.length, 5, '回填 5 件 REQ_SPEC 交付物')
    assert.deepEqual(next.deliverables.map((item) => item.id), reqFound.map((rel) => `disk:${rel}`), '交付物 id 稳定幂等')
    const byPath = Object.fromEntries(next.deliverables.map((item) => [item.filePath, item]))
    assert.equal(byPath['docs/02_requirements/product_requirements.md'].type, 'doc', 'md → doc')
    assert.equal(byPath['rtl/top.v'], undefined, 'rtl 不在 REQ_SPEC 映射内')
    for (const item of next.deliverables) {
      assert.equal(item.status, 'draft', '对账只证明存在，状态记未评审草稿')
      assert.equal(item.generatedBy, 'human', '作者无法从磁盘判定，沿用 DDL 默认口径')
      assert.equal(item.version, 1, '版本从 1 起')
      assert.equal(item.name, item.filePath.split('/').at(-1), 'name 为文件名')
    }
    assert.equal(next.agentContext.messageCount, 6, 'messageCount 按真实会话消息数回填')
    assert.ok(next.agentContext.lastActiveAt, 'lastActiveAt 随回填写入')
    assert.equal(next.status, 'active', 'status 不写：对账不把 active 抬成 completed（门禁语义不可伪造）')
    assert.deepEqual(next.gateCheckResults, [], 'gateCheckResults 不写：绝不合成未跑过/已通过的记录')
    assert.equal(reconcilePhaseState({ phase: 'REQ_SPEC', state: next, workspaceDir: workspace, sessionDir }), null, '二次对账幂等：已回填记录无变化返回 null')
  }

  // ---------- 5) 有状态 + 产物被删 → 不回填错误状态（历史语义保留） ----------
  {
    const recorded = {
      ...freshState(),
      status: 'completed',
      deliverables: [{
        id: 'disk:docs/02_requirements/product_requirements.md',
        type: 'doc',
        name: 'product_requirements.md',
        filePath: 'docs/02_requirements/product_requirements.md',
        status: 'draft',
        generatedBy: 'human',
        version: 1
      }],
      // messageCount 与会话实况对齐，排除计数校正，单独验证"记录不被回删"
      agentContext: { messageCount: countPhaseSessionMessages(sessionDir, 'REQ_SPEC').messageCount, lastActiveAt: countPhaseSessionMessages(sessionDir, 'REQ_SPEC').lastActiveAt },
      gateCheckResults: [{ checkId: 'rtm-complete', checkName: 'RTM 完备', passed: true, severity: 'error', message: '通过', autoFixable: false }],
      completedAt: '2026-10-01T00:00:00.000Z'
    }
    const emptyWorkspace = join(root, 'empty-workspace')
    assert.equal(
      reconcilePhaseState({ phase: 'REQ_SPEC', state: recorded, workspaceDir: emptyWorkspace, sessionDir }),
      null,
      '已有记录不动：产物被删不回删历史交付物/门禁/完成时间（全量清除走 resetPhase 从0开始）'
    )
    assert.equal(
      reconcilePhaseState({ phase: 'RTL', state: freshState(), workspaceDir: emptyWorkspace, sessionDir: join(root, 'empty-sessions') }),
      null,
      '从0开始：purge 后的空状态保持干净，不回填任何错误状态'
    )
  }

  // ---------- 6) 会话被归档/清空 → messageCount 如实归零（与从0重计一致） ----------
  {
    const state = { ...freshState(), agentContext: { messageCount: 6 } }
    const next = reconcilePhaseState({ phase: 'REQ_SPEC', state, workspaceDir: workspace, sessionDir: join(root, 'empty-sessions') })
    assert.ok(next, '会话消失后计数校正应发生')
    assert.equal(next.agentContext.messageCount, 0, 'messageCount 按磁盘实况归零')
    assert.equal(next.deliverables.length, 5, '产物仍在，deliverables 回填不受会话影响')
  }

  // ---------- 7) 项目级聚合：只列真正变化的阶段，区分交付物回填子集 ----------
  {
    const phases = Object.fromEntries(PHASE_ORDER.map((phase) => [phase, freshState()]))
    // VERIF 预置交付物记录（对账跳过发现），单独隔离"计数校正"路径
    phases.VERIF = {
      ...phases.VERIF,
      deliverables: [{
        id: 'disk:verification/results/tiny/result.json',
        type: 'report',
        name: 'result.json',
        filePath: 'verification/results/tiny/result.json',
        status: 'draft',
        generatedBy: 'human',
        version: 1
      }],
      agentContext: { messageCount: 5 }
    }
    const result = reconcileProjectPhases({ phases, workspaceDir: workspace, sessionDir })
    assert.deepEqual(result.changedPhases, ['REQ_SPEC', 'ARCH', 'RTL', 'VERIF'], 'REQ_SPEC/ARCH/RTL 产物回填，VERIF 计数校正')
    assert.deepEqual(result.deliverablesBackfilledPhases, ['REQ_SPEC', 'ARCH', 'RTL'], 'VERIF 只有计数校正，不记交付物回填')
    assert.equal(result.phases.ARCH.deliverables.length, 1, 'ARCH 发现 architecture.md 一件交付物')
    assert.equal(result.phases.VERIF.agentContext.messageCount, 0, 'VERIF 无会话文件，计数从 5 校正为 0')
    assert.equal(result.phases.QA.deliverables.length, 0, 'QA 无映射产物，保持原状')
    assert.equal(result.phases.ARCH.status, 'active', '聚合同样不写 status')
    assert.equal(result.phases.ARCH.gateCheckResults.length, 0, '聚合同样不写门禁记录')
    const again = reconcileProjectPhases({ phases: result.phases, workspaceDir: workspace, sessionDir })
    assert.equal(again.changedPhases.length, 0, '聚合二次执行收敛：无变化')
  }

  console.log('\n✅ 阶段状态对账冒烟全部通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
