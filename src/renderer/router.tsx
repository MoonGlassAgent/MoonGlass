/**
 * 路由定义（TanStack Router，代码式路由）
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect
} from '@tanstack/react-router'
import { AppLayout } from './layouts/AppLayout'
import { ProjectsPage } from './pages/ProjectsPage'
import { WorkspacePage } from './pages/WorkspacePage'
import { IpLibraryPage } from './pages/IpLibraryPage'
import { ScriptsPage } from './pages/ScriptsPage'
import { KnowledgePage } from './pages/KnowledgePage'
import { SettingsPage } from './pages/SettingsPage'
import { DesignBrowserPage } from './pages/DesignBrowserPage'
import { ProcessLibrariesPage } from './pages/ProcessLibrariesPage'

const rootRoute = createRootRoute({
  component: AppLayout
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/projects' })
  },
  component: () => null
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage
})

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspace/$projectId',
  component: WorkspacePage
})

const designBrowserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/design-browser/$projectId',
  component: DesignBrowserPage
})

const ipLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ip-library',
  component: IpLibraryPage
})

const processLibrariesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/process-libraries',
  component: ProcessLibrariesPage
})

const scriptsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scripts',
  component: ScriptsPage
})

const knowledgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/knowledge',
  component: KnowledgePage
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  workspaceRoute,
  designBrowserRoute,
  ipLibraryRoute,
  processLibrariesRoute,
  scriptsRoute,
  knowledgeRoute,
  settingsRoute
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
