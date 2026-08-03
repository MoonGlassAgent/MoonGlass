import { useEffect, useState } from 'react'
import { applyTheme, getTheme, THEMES, type ThemeId } from '../theme'

interface ThemePickerProps {
  compact?: boolean
}

export function ThemePicker({ compact = false }: ThemePickerProps): React.JSX.Element {
  const [selected, setSelected] = useState<ThemeId>(getTheme)

  useEffect(() => {
    const sync = (event: Event): void => setSelected((event as CustomEvent<ThemeId>).detail)
    window.addEventListener('moonglass-theme-change', sync)
    return () => window.removeEventListener('moonglass-theme-change', sync)
  }, [])

  const choose = (theme: ThemeId): void => {
    setSelected(theme)
    applyTheme(theme)
  }

  return (
    <div className={compact ? 'theme-picker theme-picker-compact' : 'theme-picker'} role="radiogroup" aria-label="界面主题">
      {THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          role="radio"
          aria-checked={selected === theme.id}
          className={`theme-option ${selected === theme.id ? 'is-selected' : ''}`}
          onClick={() => choose(theme.id)}
          title={theme.name}
        >
          <span className="theme-swatch" style={{ backgroundColor: theme.color }} />
          {!compact && <span>{theme.name}</span>}
        </button>
      ))}
    </div>
  )
}
