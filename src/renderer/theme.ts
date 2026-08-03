export const THEMES = [
  { id: 'glacier', name: '冰川蓝', color: '#2563eb' },
  { id: 'jade', name: '翡翠绿', color: '#0f8a68' },
  { id: 'graphite', name: '石墨灰', color: '#3f4652' },
  { id: 'coral', name: '珊瑚红', color: '#c84f45' }
] as const

export type ThemeId = typeof THEMES[number]['id']

const STORAGE_KEY = 'moonglass-theme'

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY)
  return THEMES.some((theme) => theme.id === stored) ? stored as ThemeId : 'glacier'
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(STORAGE_KEY, theme)
  window.dispatchEvent(new CustomEvent('moonglass-theme-change', { detail: theme }))
}

export function initializeTheme(): void {
  document.documentElement.dataset.theme = getTheme()
}
