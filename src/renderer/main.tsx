import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { router } from './router'
import './styles.css'
import { initializeTheme } from './theme'
import { initializeLocale } from './i18n'
import { RendererErrorBoundary } from './components/RendererErrorBoundary'

initializeTheme()
initializeLocale()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <RouterProvider router={router} />
    </RendererErrorBoundary>
  </React.StrictMode>
)

window.addEventListener('error', (event) => console.error('[renderer-window-error]', event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => console.error('[renderer-unhandled-rejection]', event.reason))
