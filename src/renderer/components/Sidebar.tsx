/**
 * 左侧导航栏
 *
 * 导航项与芯片开发工作流对齐：项目 / IP库 / 脚本 / 知识库 / 设置。
 * （工作区页由项目卡片跳转进入，不在导航中）
 */

import { Link, useRouterState } from '@tanstack/react-router'
import logoUrl from '../assets/logo.png'

interface NavItem {
  to: string
  label: string
  icon: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/projects', label: '项目', icon: '▣' },
  { to: '/ip-library', label: 'IP库', icon: '◈' },
  { to: '/scripts', label: '脚本', icon: '🐍' },
  { to: '/knowledge', label: '知识库', icon: '▤' },
  { to: '/settings', label: '设置', icon: '⚙' }
]

export function Sidebar(): React.JSX.Element {
  const { location } = useRouterState()

  return (
    <nav className="flex w-16 flex-col items-center gap-1 border-r border-zinc-200 bg-white py-4">
      <div className="mb-4" title="MoonGlass">
        <img src={logoUrl} alt="MoonGlass" className="size-9 rounded-lg" />
      </div>
      {NAV_ITEMS.map((item) => {
        const active = location.pathname.startsWith(item.to)
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`flex h-12 w-12 flex-col items-center justify-center rounded-lg text-xs transition-colors ${
              active
                ? 'bg-zinc-200 text-zinc-900'
                : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800'
            }`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span className="mt-1 scale-90">{item.label}</span>
          </Link>
        )
      })}
      <div className="mt-auto px-1 text-center text-[10px] leading-tight text-zinc-400">
        v0.1
      </div>
    </nav>
  )
}
