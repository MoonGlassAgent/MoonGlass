/**
 * 渲染进程国际化（i18n）运行时
 *
 * 机制仿照 theme.ts：localStorage 持久化 + CustomEvent 广播 + 启动时恢复。
 * 文案资源按命名空间拆分在 locales/<locale>/<namespace>.ts；
 * 英文资源以 `typeof` 中文资源为类型约束，缺键/多键会在 typecheck 时报错。
 *
 * 使用约定：
 * - 组件内：`const { t } = useTranslation()`，文案写 `t('sidebar.projects')`；
 * - 纯逻辑文件：直接 `import { t } from '../i18n'`（路径按实际位置）；
 * - 插值：`t('key', { name: 'xxx' })` 替换文案中的 `{name}`；
 * - 阶段显示名：`phaseLabel(phase)`（主进程报告/Agent 提示词仍用 shared 的 PHASE_LABELS）；
 * - 新页面文案一律新建命名空间文件，禁止硬编码界面文案。
 */

import { useSyncExternalStore } from 'react'
import type { Phase } from '@shared/types'
import { zhCN, type Messages } from './locales/zh-CN/index.ts'
import { en } from './locales/en/index.ts'

export type Locale = 'zh-CN' | 'en'
export type { Messages }

export const LOCALES: ReadonlyArray<{ id: Locale; name: string }> = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'en', name: 'English' }
]

const STORAGE_KEY = 'moonglass-locale'
const LOCALE_CHANGE_EVENT = 'moonglass-locale-change'

const MESSAGES: Record<Locale, Messages> = { 'zh-CN': zhCN, en }

export function getLocale(): Locale {
  // Node 环境（冒烟脚本直接 import 纯逻辑文件）没有 localStorage/navigator，回退默认中文
  if (typeof localStorage === 'undefined' || typeof navigator === 'undefined') return 'zh-CN'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'zh-CN' || stored === 'en') return stored
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function setLocale(locale: Locale): void {
  localStorage.setItem(STORAGE_KEY, locale)
  document.documentElement.lang = locale
  window.dispatchEvent(new CustomEvent(LOCALE_CHANGE_EVENT, { detail: locale }))
}

export function initializeLocale(): void {
  document.documentElement.lang = getLocale()
}

// 将嵌套资源展开为点分隔键名联合类型，如 'sidebar.projects' / 'common.ok'
type FlatKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : FlatKeys<T[K], `${Prefix}${K}.`>
}[keyof T & string]

export type MessageKey = FlatKeys<Messages>

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let node: unknown = MESSAGES[getLocale()]
  for (const part of key.split('.')) {
    node = (node as Record<string, unknown>)[part]
  }
  let text = typeof node === 'string' ? node : key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return text
}

/** 阶段显示名（渲染层界面专用；写入文件/发给 Agent 的内容请继续用 PHASE_LABELS 中文） */
export function phaseLabel(phase: Phase): string {
  return t(`phases.${phase}`)
}

function subscribeLocale(callback: () => void): () => void {
  const handler = (): void => callback()
  window.addEventListener(LOCALE_CHANGE_EVENT, handler)
  return () => window.removeEventListener(LOCALE_CHANGE_EVENT, handler)
}

export function useTranslation(): { t: typeof t; locale: Locale } {
  const locale = useSyncExternalStore(subscribeLocale, getLocale)
  return { t, locale }
}
