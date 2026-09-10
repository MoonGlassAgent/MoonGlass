import { useEffect, useState } from 'react'
import { Laptop, Moon, Sun } from 'lucide-react'
import { applyColorMode, applyTheme, getColorMode, getTheme, THEMES, type ColorMode, type ThemeId } from '../theme'
import { useTranslation, type MessageKey } from '../i18n'

interface ThemePickerProps {
  compact?: boolean
}

const THEME_NAME_KEYS: Record<ThemeId, MessageKey> = {
  glacier: 'theme.glacier',
  jade: 'theme.jade',
  graphite: 'theme.graphite',
  coral: 'theme.coral'
}

export function ThemePicker({ compact = false }: ThemePickerProps): React.JSX.Element {
  const [selected, setSelected] = useState<ThemeId>(getTheme)
  const [colorMode, setColorMode] = useState<ColorMode>(getColorMode)
  const { t } = useTranslation()

  useEffect(() => {
    const sync = (event: Event): void => setSelected((event as CustomEvent<ThemeId>).detail)
    window.addEventListener('moonglass-theme-change', sync)
    const syncMode = (event: Event): void => setColorMode((event as CustomEvent<ColorMode>).detail)
    window.addEventListener('moonglass-color-mode-change', syncMode)
    return () => {
      window.removeEventListener('moonglass-theme-change', sync)
      window.removeEventListener('moonglass-color-mode-change', syncMode)
    }
  }, [])

  const choose = (theme: ThemeId): void => {
    setSelected(theme)
    applyTheme(theme)
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="color-mode-picker" role="radiogroup" aria-label={t('theme.colorMode')}>
        {([
          ['light', 'theme.light', Sun],
          ['dark', 'theme.dark', Moon],
          ['system', 'theme.system', Laptop]
        ] as const).map(([id, nameKey, Icon]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={colorMode === id}
            className={`color-mode-option ${colorMode === id ? 'is-selected' : ''}`}
            onClick={() => { setColorMode(id); applyColorMode(id) }}
            title={t(nameKey)}
          >
            <Icon size={14} />
            {!compact && <span>{t(nameKey)}</span>}
          </button>
        ))}
      </div>
      <div className={compact ? 'theme-picker theme-picker-compact' : 'theme-picker'} role="radiogroup" aria-label={t('theme.accent')}>
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected === theme.id}
            className={`theme-option ${selected === theme.id ? 'is-selected' : ''}`}
            onClick={() => choose(theme.id)}
            title={t(THEME_NAME_KEYS[theme.id])}
          >
            <span className="theme-swatch" style={{ backgroundColor: theme.color }} />
            {!compact && <span>{t(THEME_NAME_KEYS[theme.id])}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
