// 验证长程循环"战略层"经验账本（批次/修复会话间传递可复用经验）：
// 主进程纯函数模块（账本归一/损坏回空、≤50 条新在前截断、同 text+tags 幂等复用 id、
// text ≤200 字截断 / tags ≤5 个每个 ≤24 字、prompt 编号列表 ≤1000 字省略注"另有 N 条"）、
// 引擎 buildBatchPrompt 经验摘要段注入（有 notes 才渲染、纪律句、位置在环境就绪摘要之后）、
// pi 工具 record_experience_note 与 review_verification_evidence 软强制 warning 的源码标记断言。
// 与 batch-prompt-smoke 同模式：Node 原生转译 import TS 源码。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  EXPERIENCE_NOTES_LIMIT,
  EXPERIENCE_NOTE_TEXT_MAX,
  EXPERIENCE_NOTE_TAGS_MAX,
  EXPERIENCE_NOTE_TAG_MAX,
  EXPERIENCE_NOTE_ID_PATTERN,
  EXPERIENCE_NOTES_PROMPT_MAX_CHARS,
  appendExperienceNote,
  experienceNotesPath,
  formatExperienceNotesForPrompt,
  readExperienceNotes,
  writeExperienceNotes
} = await import('../src/main/services/experience-notes.ts')
const { buildVerificationIntelligence, buildBatchPrompt } = await import('../packages/verification-intelligence-engine/src/index.ts')

const dir = mkdtempSync(join(tmpdir(), 'moonglass-experience-notes-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })

// ── A. 读取归一：缺文件/损坏 → 空数组；缺字段/非对象条目归一 ──

assert.deepEqual(readExperienceNotes(workspace), [])
writeFileSync(experienceNotesPath(workspace), '{ 这不是合法 JSON', 'utf-8')
assert.deepEqual(readExperienceNotes(workspace), [])
writeExperienceNotes(workspace, {
  version: 1,
  generatedAt: '2026-10-05T00:00:00.000Z',
  notes: [
    { id: 'EXP-00000001', text: 'cocotb make 需加 WAVES=1 才出波形', tags: ['env-usage'], source: 'batch-3', createdAt: '2026-10-01T00:00:00.000Z' },
    { text: 42, tags: 'oops' },
    'garbage',
    null
  ]
})
const normalized = readExperienceNotes(workspace)
assert.equal(normalized.length, 2)
assert.equal(normalized[0].id, 'EXP-00000001')
assert.equal(normalized[1].id, '')
assert.equal(normalized[1].text, '42')
assert.deepEqual(normalized[1].tags, [])

// ── B. 追加校验：text 非空、截断、tags 截断；id 形态 EXP-<8hex 大写>；新在前 ──

assert.throws(() => appendExperienceNote(workspace, { text: '   ', tags: [], source: 's' }), /不能为空/)
const longText = '甲'.repeat(EXPERIENCE_NOTE_TEXT_MAX + 50)
const longNote = appendExperienceNote(workspace, { text: longText, tags: [], source: 'fix-session-7' })
assert.equal(longNote.text.length, EXPERIENCE_NOTE_TEXT_MAX)
assert.match(longNote.id, EXPERIENCE_NOTE_ID_PATTERN)
const manyTags = appendExperienceNote(workspace, {
  text: 'scoreboard 比较需在时钟下降沿采样',
  tags: ['tb-pitfall', '乙'.repeat(EXPERIENCE_NOTE_TAG_MAX + 10), '', 'dma_wr_ctrl', 'SCN-AAAAAAAA', 'env-usage', 'build-param'],
  source: 'fix-session-7'
})
assert.equal(manyTags.tags.length, EXPERIENCE_NOTE_TAGS_MAX)
assert.equal(manyTags.tags[1].length, EXPERIENCE_NOTE_TAG_MAX)
assert.ok(manyTags.tags.every((tag) => tag.length > 0))
assert.equal(readExperienceNotes(workspace)[0].id, manyTags.id)

// ── C. 幂等：同 text+tags 复用同 id、刷新 createdAt、提升到最前、不新增条目 ──

appendExperienceNote(workspace, { text: 'verilator 构建参数 -Wno-fatal 已验证可用', tags: ['build-param'], source: 'batch-1' }, '2026-10-02T00:00:00.000Z')
appendExperienceNote(workspace, { text: '复位释放需等待两个时钟后再发激励', tags: ['tb-pitfall'], source: 'batch-2' }, '2026-10-03T00:00:00.000Z')
const beforeCount = readExperienceNotes(workspace).length
const first = appendExperienceNote(workspace, { text: 'verilator 构建参数 -Wno-fatal 已验证可用', tags: ['build-param'], source: 'batch-9' }, '2026-10-05T00:00:00.000Z')
const after = readExperienceNotes(workspace)
assert.equal(after.length, beforeCount)
assert.equal(after[0].id, first.id)
assert.match(first.id, EXPERIENCE_NOTE_ID_PATTERN)
assert.equal(first.createdAt, '2026-10-05T00:00:00.000Z')
assert.equal(first.source, 'batch-1')
// tags 顺序参与幂等身份：顺序不同视为新经验
const reordered = appendExperienceNote(workspace, { text: 'verilator 构建参数 -Wno-fatal 已验证可用', tags: ['env-usage', 'build-param'], source: 'batch-9' })
assert.notEqual(reordered.id, first.id)

// ── D. 滚动上限 ≤50 条 ──

const fresh = join(dir, 'ws-limit')
mkdirSync(join(fresh, 'verification', 'results'), { recursive: true })
for (let index = 0; index < EXPERIENCE_NOTES_LIMIT + 10; index++) {
  appendExperienceNote(fresh, { text: `经验 ${index}`, tags: [], source: 'loop' }, `2026-10-05T00:00:${String(index % 60).padStart(2, '0')}.000Z`)
}
assert.equal(EXPERIENCE_NOTES_LIMIT, 50)
assert.equal(readExperienceNotes(fresh).length, EXPERIENCE_NOTES_LIMIT)
assert.equal(readExperienceNotes(fresh)[0].text, `经验 ${EXPERIENCE_NOTES_LIMIT + 9}`)

// ── E. prompt 格式化：编号列表、≤1000 字、超出省略注"另有 N 条" ──

assert.equal(formatExperienceNotesForPrompt([]), '')
const formatted = formatExperienceNotesForPrompt(readExperienceNotes(fresh))
assert.ok(formatted.startsWith('1. '))
assert.ok(!formatted.includes(`51.`))
const notes = Array.from({ length: 30 }, (_, index) => ({ id: `EXP-${String(index).padStart(8, '0')}`, text: `丙`.repeat(100) + index, tags: [], source: 's', createdAt: '2026-10-05T00:00:00.000Z' }))
const capped = formatExperienceNotesForPrompt(notes, 500)
assert.ok(capped.includes('另有'))
assert.ok(capped.length <= 500 + 100) // 省略注本身不计入编号列表预算
assert.equal(EXPERIENCE_NOTES_PROMPT_MAX_CHARS, 1000)
const tagged = formatExperienceNotesForPrompt([{ id: 'EXP-AAAAAAAA', text: 'aborted 事务需 drain 完成', tags: ['dma_wr_ctrl', 'env-usage'], source: 's', createdAt: '2026-10-05T00:00:00.000Z' }])
assert.ok(tagged.includes('（dma_wr_ctrl、env-usage）'))

// ── F. 引擎注入：buildBatchPrompt 在环境就绪摘要之后插入经验摘要段（有 notes 才渲染）──

const eng = join(dir, 'ws-engine')
mkdirSync(join(eng, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(eng, 'rtl'), { recursive: true })
mkdirSync(join(eng, 'verification', 'results', 'dma'), { recursive: true })
writeFileSync(join(eng, 'docs', '02_requirements', 'product_requirements.md'), `
# DMA Requirements

- REQ-DMA-001 P0: abort stops new requests while outstanding responses may complete.
- REQ-DMA-002 P0: timeout and late response priority shall be deterministic.
`, 'utf-8')
writeFileSync(join(eng, 'rtl', 'dma_wr_ctrl.v'), `
module dma_wr_ctrl(input clk, input rst_n, input abort, input timeout, input bvalid, output reg [2:0] state);
  reg [3:0] outstanding_cnt;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin state <= 0; outstanding_cnt <= 0; end
    else if (abort) state <= 3;
    else if (timeout) state <= 4;
    else if (bvalid) begin state <= 5; outstanding_cnt <= outstanding_cnt - 1; end
  end
endmodule
`, 'utf-8')
writeFileSync(join(eng, 'rtl', 'design.json'), JSON.stringify({ topModule: 'dma_wr_ctrl', filelist: 'filelist.f' }, null, 2), 'utf-8')
writeFileSync(join(eng, 'verification', 'results', 'dma', 'result.json'), JSON.stringify({ passed: true, testsTotal: 4, coverage: { lineCoverage: 92 } }, null, 2), 'utf-8')

const artifacts = buildVerificationIntelligence(eng)
const cluster = artifacts.verificationState.executionClusters[0]
const batchIds = cluster.executionBatches[0]

// 无经验账本：不渲染经验摘要段
const promptEmpty = buildBatchPrompt(eng, batchIds)
assert.ok(!promptEmpty.includes('经验摘要'), '无经验账本时不应渲染经验摘要段')

// 写入经验账本（经主进程模块登记，保持同一写路径）：
appendExperienceNote(eng, { text: 'cocotb make 编译需加 SIM=verilator，否则默认 iverilog 不支持 SystemVerilog', tags: ['env-usage', 'dma_wr_ctrl'], source: 'batch-3' })
appendExperienceNote(eng, { text: 'scoreboard 在 abort 场景需允许 outstanding 排空后再判空', tags: ['tb-pitfall', 'SCN-AAAAAAAA'], source: 'fix-session-2' })
const prompt = buildBatchPrompt(eng, batchIds)
const digestStart = prompt.indexOf('## 经验摘要（历史会话登记）')
assert.ok(digestStart > 0, '批次 prompt 缺少经验摘要段')
assert.ok(prompt.includes('以下为历史会话登记的可复用经验，优先采用，避免重复探索'), '经验摘要缺纪律句')
assert.ok(prompt.includes('1. scoreboard 在 abort 场景需允许 outstanding 排空后再判空（tb-pitfall、SCN-AAAAAAAA）'), '经验摘要缺第一条经验（含标签）')
assert.ok(prompt.includes('2. cocotb make 编译需加 SIM=verilator，否则默认 iverilog 不支持 SystemVerilog'), '经验摘要缺第二条经验')
// 位置：环境就绪摘要之后、场景详情/聚类组语义之前
assert.ok(prompt.indexOf('环境状态') < digestStart, '经验摘要应位于环境就绪摘要之后')
assert.ok(digestStart < prompt.indexOf(`## 场景 ${batchIds[0]}`), '经验摘要应位于场景详情之前')

// 空 notes 数组：同样不渲染
writeFileSync(join(eng, 'verification', 'results', 'experience-notes.json'), JSON.stringify({ version: 1, generatedAt: '2026-10-05T00:00:00.000Z', notes: [] }), 'utf-8')
assert.ok(!buildBatchPrompt(eng, batchIds).includes('经验摘要'), '空 notes 不应渲染经验摘要段')

// 损坏账本：不渲染（引擎侧按无经验处理，不阻断批次派发）
writeFileSync(join(eng, 'verification', 'results', 'experience-notes.json'), '{ 损坏', 'utf-8')
assert.ok(!buildBatchPrompt(eng, batchIds).includes('经验摘要'), '损坏账本不应渲染经验摘要段')

// 大量经验：注入段 ≤1000 字编号列表 + 省略注
writeExperienceNotes(eng, {
  version: 1,
  generatedAt: '2026-10-05T00:00:00.000Z',
  notes: Array.from({ length: 40 }, (_, index) => ({
    id: `EXP-${String(index).padStart(8, '0')}`,
    text: `丁`.repeat(90) + index,
    tags: ['env-usage'],
    source: 's',
    createdAt: '2026-10-05T00:00:00.000Z'
  }))
})
const promptMany = buildBatchPrompt(eng, batchIds)
assert.ok(promptMany.includes('另有'), '大量经验时注入段应省略并注"另有 N 条"')
const afterDigest = promptMany.slice(promptMany.indexOf('## 经验摘要（历史会话登记）') + '## 经验摘要（历史会话登记）'.length)
const digestBody = afterDigest.slice(afterDigest.indexOf('避免重复探索。') + '避免重复探索。'.length, afterDigest.search(/\n## /)).trim()
assert.ok(digestBody.length <= 1000 + 100, `注入段编号列表超出预算：${digestBody.length} 字`)

// ── G. pi 工具与软强制 warning 源码标记断言（与 pi-tools-smoke 同方式）──

const toolsSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')
for (const marker of [
  "name: 'record_experience_note'",
  'appendExperienceNoteLedger',
  'ExperienceNoteRecord',
  'experience-notes.json',
  'EXP-',
  'EXPERIENCE_NOTES_LIMIT',
  'generatedAt: record.createdAt',
  'maxLength: 200',
  'maxItems: 5',
  'maxLength: 24',
  '常规问答禁止调用',
  '已验证构建参数',
  '典型失败模式',
  // 软强制 warning：FAIL→PASS 场景无关联经验标签 → 提醒登记（不阻断）
  'experienceTags',
  'experience-notes.json 无该场景标签',
  'record_experience_note 顺手登记'
]) {
  assert.ok(toolsSource.includes(marker), `moonglass-tools.ts 缺少标记：${marker}`)
}
// 工具 schema 形状与契约逐字一致（text maxLength 200 / tags maxItems 5 / 元素 maxLength 24）
const toolBlock = toolsSource.slice(toolsSource.indexOf("name: 'record_experience_note'"), toolsSource.indexOf("name: 'propose_run_decision'"))
assert.ok(toolBlock.includes('Type.String({ maxLength: 200'), 'record_experience_note text schema 不符')
assert.ok(toolBlock.includes('Type.Array(Type.String({ maxLength: 24 }), { maxItems: 5'), 'record_experience_note tags schema 不符')
assert.ok(toolBlock.includes('Type.Optional'), 'record_experience_note tags 应为可选')

console.log('Experience Notes smoke passed: 归一/截断/幂等/校验/prompt 省略/引擎注入段/工具标记全部通过')
