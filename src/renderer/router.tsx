/**
 * 路由定义（TanStack Router，代码式路由）
 */

import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect
} from '@tanstack/react-router'
import { AppLayout } from './layouts/AppLayout'
import { ProjectsPage } from './pages/ProjectsPage'

const WorkspacePage = lazyRouteComponent(() => import('./pages/WorkspacePage'), 'WorkspacePage')
const DesignBrowserPage = lazyRouteComponent(() => import('./pages/DesignBrowserPage'), 'DesignBrowserPage')
const VerificationPosturePage = lazyRouteComponent(() => import('./pages/VerificationPosturePage'), 'VerificationPosturePage')
const IpLibraryPage = lazyRouteComponent(() => import('./pages/IpLibraryPage'), 'IpLibraryPage')
const ProcessLibrariesPage = lazyRouteComponent(() => import('./pages/ProcessLibrariesPage'), 'ProcessLibrariesPage')
const ScriptsPage = lazyRouteComponent(() => import('./pages/ScriptsPage'), 'ScriptsPage')
const KnowledgePage = lazyRouteComponent(() => import('./pages/KnowledgePage'), 'KnowledgePage')
const SettingsPage = lazyRouteComponent(() => import('./pages/SettingsPage'), 'SettingsPage')
const InformationPage = lazyRouteComponent(() => import('./pages/InformationPage'), 'InformationPage')

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

const verificationPostureRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verification-posture/$projectId',
  component: VerificationPosturePage
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

const informationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/information',
  component: InformationPage
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  workspaceRoute,
  designBrowserRoute,
  verificationPostureRoute,
  ipLibraryRoute,
  processLibrariesRoute,
  scriptsRoute,
  knowledgeRoute,
  settingsRoute,
  informationRoute
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
