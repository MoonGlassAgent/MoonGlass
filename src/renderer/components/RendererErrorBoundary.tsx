import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface State { error: Error | null }

export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[renderer-error-boundary]', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return <main className="flex h-screen items-center justify-center bg-zinc-100 p-8 text-zinc-900">
      <section className="w-full max-w-xl border border-red-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-red-700"><AlertTriangle size={20} /><h1 className="text-base font-semibold">界面组件发生异常</h1></div>
        <p className="mt-3 text-sm text-zinc-600">MoonGlass 已隔离本次界面错误，项目文件和 Agent 会话不会丢失。请重新加载界面；若问题重复出现，可根据下方信息定位。</p>
        <pre className="mt-4 max-h-40 overflow-auto border border-zinc-200 bg-zinc-50 p-3 text-xs text-red-700">{this.state.error.message}</pre>
        <button onClick={() => window.location.reload()} className="mt-4 inline-flex items-center gap-2 rounded bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700"><RefreshCw size={15} />重新加载界面</button>
      </section>
    </main>
  }
}
