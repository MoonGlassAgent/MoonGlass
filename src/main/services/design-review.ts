/**
 * 设计评审发现清单的数据层（设计文档 DESIGN-REVIEW-LEFT-SHIFT-ZH-CN.md §6）
 *
 * ARCH 出口一致性 review 与 RTL 出口语义 review 的 review-findings.json 归一化读取、
 * pending major 计数、多轮 rounds[] 按键合并与发现稳定键计算。
 * 清单为极简四字段结构（描述/位置/严重度/处置），没有 id 字段；
 * 处置回写的稳定键 = 「位置+描述」的归一化哈希（同模式复用死逻辑裁决的 key 思路）。
 * 所有读取与归一化都是降级语义：坏 JSON / 缺字段不抛异常，由调用方按软门禁口径处理。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** ARCH 出口一致性 review 的发现清单路径（相对项目工作目录；设计文档 §4/§6） */
export const ARCH_REVIEW_FINDINGS_PATH = 'docs/03_design/review-findings.json'
/** RTL 出口语义 review 的发现清单路径（相对项目工作目录；设计文档 §5/§6） */
export const RTL_REVIEW_FINDINGS_PATH = 'rtlqa/review/review-findings.json'

/** 单条发现：恰好四字段（设计文档 §6，除此之外不加字段） */
export interface DesignReviewFinding {
  描述: string
  位置: string
  严重度: 'major' | 'minor'
  处置: 'fixed' | 'waived' | 'pending'
}

/** 单轮 review 记录（多轮清单的 rounds[] 元素；设计文档 §6） */
export interface DesignReviewRound {
  model: string
  generatedAt: string
  findings: DesignReviewFinding[]
}

/** 发现清单顶层结构；rounds 为可选（旧版单轮清单无此字段） */
export interface DesignReviewFindings {
  version: number
  generatedAt: string
  reviewRound: number
  model: string
  /** 多轮 review 历史；顶层 findings 始终表示最新一轮 */
  rounds?: DesignReviewRound[]
  findings: DesignReviewFinding[]
}

/** 跨轮合并后的发现视图：稳定键 + 四字段（处置为合并后的最新状态） */
export interface MergedReviewFinding {
  key: string
  描述: string
  位置: string
  严重度: 'major' | 'minor'
  处置: 'fixed' | 'waived' | 'pending'
}

/**
 * 发现稳定键 = 「位置+描述」的归一化哈希（sha256 截断 16 hex）。
 * 归一化只做空白折叠与首尾修剪（大小写保留——位置通常是大小写敏感的文件路径），
 * 同一发现的文本抖动（换行/多空格）不改变键值，保证多轮合并与处置回写幂等。
 */
export function findingStableKey(finding: Pick<DesignReviewFinding, '位置' | '描述'>): string {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${normalize(finding.位置)}\n${normalize(finding.描述)}`).digest('hex').slice(0, 16)
}

/** 归一化单条发现：描述/位置必须是字符串，否则丢弃；严重度缺省 minor、处置缺省 pending（降级不炸） */
function normalizeFinding(raw: unknown): DesignReviewFinding | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record['描述'] !== 'string' || typeof record['位置'] !== 'string') return null
  return {
    描述: record['描述'],
    位置: record['位置'],
    严重度: record['严重度'] === 'major' ? 'major' : 'minor',
    处置: record['处置'] === 'fixed' || record['处置'] === 'waived' ? record['处置'] : 'pending'
  }
}

function normalizeFindingList(raw: unknown): DesignReviewFinding[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeFinding).filter((item): item is DesignReviewFinding => item !== null)
}

/** 归一化单轮记录：model/generatedAt 缺省为空串，findings 走条目级降级 */
function normalizeRound(raw: unknown): DesignReviewRound | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  return {
    model: typeof record['model'] === 'string' ? record['model'] : '',
    generatedAt: typeof record['generatedAt'] === 'string' ? record['generatedAt'] : '',
    findings: normalizeFindingList(record['findings'])
  }
}

/**
 * 归一化清单原始 JSON：坏结构（非对象/数组）返回 null；
 * 缺字段逐项补默认值（version=1、reviewRound 按 rounds 长度回退、rounds 缺省 []、
 * findings 缺省 []），保证旧版无 rounds 的单轮清单可直接读取。
 */
export function normalizeDesignReviewFindings(raw: unknown): DesignReviewFindings | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const rounds = Array.isArray(record['rounds'])
    ? record['rounds'].map(normalizeRound).filter((item): item is DesignReviewRound => item !== null)
    : []
  const findings = normalizeFindingList(record['findings'])
  return {
    version: typeof record['version'] === 'number' ? record['version'] : 1,
    generatedAt: typeof record['generatedAt'] === 'string' ? record['generatedAt'] : '',
    reviewRound: typeof record['reviewRound'] === 'number'
      ? record['reviewRound']
      : Math.max(1, rounds.length > 0 ? rounds.length : findings.length > 0 ? 1 : 0),
    model: typeof record['model'] === 'string' ? record['model'] : '',
    rounds,
    findings
  }
}

/**
 * 读取并归一化发现清单（相对项目工作目录的路径）：
 * 文件缺失 / JSON 无法解析 / 顶层结构非法一律返回 null，不抛异常。
 */
export function readDesignReviewFindings(workspaceDir: string, relativePath: string): DesignReviewFindings | null {
  const absolutePath = join(workspaceDir, ...relativePath.split('/'))
  if (!existsSync(absolutePath)) return null
  try {
    return normalizeDesignReviewFindings(JSON.parse(readFileSync(absolutePath, 'utf-8')))
  } catch {
    return null
  }
}

/**
 * 多轮合并口径（设计文档 §6：处置状态跨轮按键保留）：
 * rounds[] 视为较早轮次依次在前，顶层 findings 视为最新一轮在后；
 * 同键以后出现的记录覆盖先出现的（最新一轮的处置为准），只出现过一轮的键保留该轮处置。
 */
export function mergeFindingsAcrossRounds(data: DesignReviewFindings): MergedReviewFinding[] {
  const byKey = new Map<string, MergedReviewFinding>()
  const sequences: DesignReviewFinding[][] = [
    ...(data.rounds ?? []).map((round) => round.findings),
    data.findings
  ]
  for (const list of sequences) {
    for (const finding of list) {
      const key = findingStableKey(finding)
      byKey.set(key, { key, 描述: finding.描述, 位置: finding.位置, 严重度: finding.严重度, 处置: finding.处置 })
    }
  }
  return [...byKey.values()]
}

/** pending 状态的 major 发现条数（跨轮按键去重后的合并口径）；清单缺失按 0 计（软门禁不炸） */
export function pendingMajorCount(data: DesignReviewFindings | null | undefined): number {
  if (!data) return 0
  return mergeFindingsAcrossRounds(data).filter((finding) => finding.严重度 === 'major' && finding.处置 === 'pending').length
}

/**
 * 已记录的 review 轮数（供交叉 review 建议）：
 * 顶层 findings 计为最新一轮，rounds[] 计为历史轮次；无 rounds 的旧版清单按 0/1 计。
 */
export function reviewRoundCount(data: DesignReviewFindings | null | undefined): number {
  if (!data) return 0
  const history = data.rounds?.length ?? 0
  const hasCurrent = data.findings.length > 0
  if (history === 0) return hasCurrent ? 1 : 0
  return history + (hasCurrent ? 1 : 0)
}
