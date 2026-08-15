export const THEMES = [
  { id: 'glacier', name: '冰川蓝', color: '#2563eb' },
  { id: 'jade', name: '翡翠绿', color: '#0f8a68' },
  { id: 'graphite', name: '石墨灰', color: '#3f4652' },
  { id: 'coral', name: '珊瑚红', color: '#c84f45' }
] as const

export type ThemeId = typeof THEMES[number]['id']
export type ColorMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'moonglass-theme'
const COLOR_MODE_STORAGE_KEY = 'moonglass-color-mode'
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'
let removeSystemListener: (() => void) | undefined

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(STORAGE_KEY)
  return THEMES.some((theme) => theme.id === stored) ? stored as ThemeId : 'glacier'
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(STORAGE_KEY, theme)
  window.dispatchEvent(new CustomEvent('moonglass-theme-change', { detail: theme }))
}

export function getColorMode(): ColorMode {
  const stored = localStorage.getItem(COLOR_MODE_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function resolveColorMode(mode: ColorMode): 'light' | 'dark' {
  return mode === 'system'
    ? window.matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light'
    : mode
}

function updateResolvedColorMode(mode: ColorMode): void {
  document.documentElement.dataset.colorMode = resolveColorMode(mode)
  document.documentElement.style.colorScheme = resolveColorMode(mode)
}

export function applyColorMode(mode: ColorMode): void {
  localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode)
  updateResolvedColorMode(mode)
  window.dispatchEvent(new CustomEvent('moonglass-color-mode-change', { detail: mode }))
}

export function initializeTheme(): void {
  document.documentElement.dataset.theme = getTheme()
  const mode = getColorMode()
  updateResolvedColorMode(mode)
  removeSystemListener?.()
  const media = window.matchMedia(SYSTEM_DARK_QUERY)
  const syncSystem = (): void => {
    if (getColorMode() === 'system') {
      updateResolvedColorMode('system')
      window.dispatchEvent(new CustomEvent('moonglass-system-color-change'))
    }
  }
  media.addEventListener('change', syncSystem)
  removeSystemListener = () => media.removeEventListener('change', syncSystem)
}
