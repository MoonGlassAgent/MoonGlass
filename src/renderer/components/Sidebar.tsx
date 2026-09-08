/**
 * 左侧导航栏
 *
 * 导航项与芯片开发工作流对齐：项目 / IP库 / 脚本 / 知识库 / 设置。
 * （工作区页由项目卡片跳转进入，不在导航中）
 */

import { Link, useRouterState } from '@tanstack/react-router'
import { BookOpen, Boxes, CircleHelp, Factory, FolderKanban, Palette, ScrollText, Settings } from 'lucide-react'
import { APP_INFO } from '@shared/app-info'
import logoUrl from '../assets/logo.png'
import { ThemePicker } from './ThemePicker'

interface NavItem {
  to: string
  label: string
  icon: typeof FolderKanban
}

const NAV_ITEMS: NavItem[] = [
  { to: '/projects', label: '项目', icon: FolderKanban },
  { to: '/ip-library', label: 'IP库', icon: Boxes },
  { to: '/process-libraries', label: '工艺库', icon: Factory },
  { to: '/scripts', label: '脚本', icon: ScrollText },
  { to: '/knowledge', label: '知识库', icon: BookOpen },
  { to: '/settings', label: '设置', icon: Settings },
  { to: '/information', label: '关于', icon: CircleHelp }
]

export function Sidebar(): React.JSX.Element {
  const { location } = useRouterState()

  return (
    <nav className="app-sidebar flex w-16 flex-col items-center gap-1 border-r border-zinc-200 bg-white py-4">
      <div className="logo-interaction mb-4" tabIndex={0} aria-label="MoonGlass">
        <img src={logoUrl} alt="MoonGlass" className="logo-small size-9 rounded-lg" />
        <div className="logo-preview" role="tooltip">
          <img src={logoUrl} alt="" />
          <strong>MoonGlass</strong>
          <span>ASIC Design Agent</span>
        </div>
      </div>
      {NAV_ITEMS.map((item) => {
        const active = location.pathname.startsWith(item.to)
        const Icon = item.icon
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`nav-item flex h-12 w-12 flex-col items-center justify-center rounded-lg text-xs ${
              active
                ? 'bg-zinc-200 text-zinc-900'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
            }`}
          >
            <Icon size={17} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
            <span className="mt-1 scale-90">{item.label}</span>
          </Link>
        )
      })}
      <div className="sidebar-theme mt-auto">
        <button type="button" className="theme-trigger" title="切换主题" aria-label="切换主题"><Palette size={17} /></button>
        <div className="theme-popover">
          <div className="theme-popover-title">外观与强调色</div>
          <ThemePicker compact />
        </div>
      </div>
      <div className="mt-2 px-1 text-center text-[10px] leading-tight text-zinc-400">
        v{APP_INFO.version}
      </div>
    </nav>
  )
}
