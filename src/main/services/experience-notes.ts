/**
 * 验证长程循环"战略层"经验账本（批次/修复会话间传递可复用经验，消灭每批重复探索：
 * 2026-10 实测批次会话反复重读同一环境文件，固定探索成本摊不薄）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path / node:crypto，不引入 electron，
 * 可由 scripts/experience-notes-smoke.mjs 直接转译测试
 * （与 decision-ledger.ts / verif-loop-ledger.ts 同口径）。
 *
 * 账本文件：verification/results/experience-notes.json（version: 1，原子写 + 缺字段归一，
 * ≤50 条新在前）。写入一律走登记（pi 工具 record_experience_note / 本模块 append），
 * 禁止 Agent 手写 JSON（与 root-causes 同一纪律）。pi-bridge 侧因无法 import 本模块，
 * 在 moonglass-tools.ts 内自带同 schema 落盘实现，读写口径以本文件为准。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameSyncWithRetry } from './atomic-write.ts'

/** 经验账本滚动上限（契约：≤50 条，新在前） */
export const EXPERIENCE_NOTES_LIMIT = 50
/** 经验正文长度上限（契约：≤200 字，超出截断） */
export const EXPERIENCE_NOTE_TEXT_MAX = 200
/** 经验标签数量上限（契约：≤5 个） */
export const EXPERIENCE_NOTE_TAGS_MAX = 5
/** 单个经验标签长度上限（契约：≤24 字，超出截断） */
export const EXPERIENCE_NOTE_TAG_MAX = 24
/** 经验摘要注入批次 prompt 的字数预算（契约：≤1000 字，超出省略注"另有 N 条"） */
export const EXPERIENCE_NOTES_PROMPT_MAX_CHARS = 1000
/** 经验 ID 形态：EXP-<8hex 大写>（契约） */
export const EXPERIENCE_NOTE_ID_PATTERN = /^EXP-[0-9A-F]{8}$/

const LEDGER_RELATIVE_PATH = join('verification', 'results', 'experience-notes.json')

/** 经验记录（experience-notes.json notes 元素，契约 schema 逐字固定） */
export interface ExperienceNote {
  id: string
  /** 经验正文，≤200 字 */
  text: string
  tags: string[]
  /** 来源会话名 */
  source: string
  createdAt: string
}

/** 经验账本营（experience-notes.json 顶层，契约 schema 逐字固定） */
export interface ExperienceNotesLedger {
  version: 1
  generatedAt: string
  notes: ExperienceNote[]
}

export function experienceNotesPath(workspace: string): string {
  return join(workspace, LEDGER_RELATIVE_PATH)
}

/** 生成 EXP-<8hex 大写> id；与现存条目撞号时重掷（16^8 空间，实际几乎不可能发生）。 */
function generateExperienceNoteId(existing: ReadonlySet<string>): string {
  for (;;) {
    const id = `EXP-${randomBytes(4).toString('hex').toUpperCase()}`
    if (!existing.has(id)) return id
  }
}

/** 单条记录缺字段归一（version 演进预留；非对象条目丢弃）。 */
function normalizeNote(value: unknown): ExperienceNote | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  return {
    id: String(item.id ?? ''),
    text: String(item.text ?? ''),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    source: String(item.source ?? ''),
    createdAt: String(item.createdAt ?? '')
  }
}

/** 读取经验账本；缺文件/损坏/无 notes 数组返回空数组（调用方按无经验处理），读取时强制滚动上限。 */
export function readExperienceNotes(workspace: string): ExperienceNote[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(experienceNotesPath(workspace), 'utf-8'))
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const data = raw as Record<string, unknown>
  if (!Array.isArray(data.notes)) return []
  return data.notes
    .map(normalizeNote)
    .filter((item): item is ExperienceNote => item !== null)
    .slice(0, EXPERIENCE_NOTES_LIMIT)
}

/** 原子写经验账本（临时文件 + rename，避免并发读到半截 JSON）。 */
export function writeExperienceNotes(workspace: string, ledger: ExperienceNotesLedger): void {
  const path = experienceNotesPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...ledger, version: 1 }, null, 2), 'utf-8')
  // rename 走 EPERM/EBUSY 退避重试（Windows 杀毒瞬时持锁，见 atomic-write.ts）
  renameSyncWithRetry(temporary, path)
}

/**
 * 追加一条经验（新在前、原子写、每次写入强制滚动上限）：
 * text 非空校验（空白串拒绝）；text ≤200 字截断；tags 去空白后截到 ≤5 个、每个 ≤24 字；
 * 幂等——同 text+tags 重复登记复用同 id，仅刷新 createdAt 并提升到最前（重复探索的自然去重）。
 */
export function appendExperienceNote(
  workspace: string,
  input: { text: string; tags?: string[]; source: string },
  now: string = new Date().toISOString()
): ExperienceNote {
  const text = input.text.trim().slice(0, EXPERIENCE_NOTE_TEXT_MAX)
  if (!text) throw new Error('经验正文（text）不能为空')
  const tags = (input.tags ?? [])
    .map((tag) => tag.trim().slice(0, EXPERIENCE_NOTE_TAG_MAX))
    .filter((tag) => tag.length > 0)
    .slice(0, EXPERIENCE_NOTE_TAGS_MAX)
  const existing = readExperienceNotes(workspace)
  const identity = JSON.stringify({ text, tags })
  const reused = existing.find((note) => JSON.stringify({ text: note.text, tags: note.tags }) === identity)
  const record: ExperienceNote = reused
    ? { ...reused, createdAt: now }
    : {
        id: generateExperienceNoteId(new Set(existing.map((note) => note.id))),
        text,
        tags,
        source: input.source,
        createdAt: now
      }
  const notes = [record, ...existing.filter((note) => note.id !== record.id)].slice(0, EXPERIENCE_NOTES_LIMIT)
  writeExperienceNotes(workspace, { version: 1, generatedAt: now, notes })
  return record
}

/**
 * 经验摘要（编号列表）注入批次 prompt：total ≤maxChars（默认 1000 字），
 * 超出的条数省略并注"另有 N 条"。无经验返回空串（调用方不渲染该段）。
 * 格式与引擎包 buildExperienceDigest 等价实现逐字一致（两处各自维护，改动需同步）。
 */
export function formatExperienceNotesForPrompt(notes: readonly ExperienceNote[], maxChars: number = EXPERIENCE_NOTES_PROMPT_MAX_CHARS): string {
  if (notes.length === 0) return ''
  const lines: string[] = []
  let used = 0
  for (const [index, note] of notes.entries()) {
    const tagSuffix = note.tags.length ? `（${note.tags.join('、')}）` : ''
    const line = `${index + 1}. ${note.text}${tagSuffix}`
    const next = used === 0 ? line.length : used + 1 + line.length
    if (index > 0 && next > maxChars) {
      lines.push(`（另有 ${notes.length - index} 条经验未展开，详见 verification/results/experience-notes.json）`)
      return lines.join('\n')
    }
    lines.push(line)
    used = next
  }
  return lines.join('\n')
}
