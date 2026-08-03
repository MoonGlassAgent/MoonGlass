/**
 * 应用主布局：左侧图标导航栏 + 内容区
 */

import { Outlet } from '@tanstack/react-router'
import { Sidebar } from '../components/Sidebar'

export function AppLayout(): React.JSX.Element {
  return (
    <div className="app-shell flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
