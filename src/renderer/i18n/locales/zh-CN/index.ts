import { chat } from './chat.ts'
import { common } from './common.ts'
import { components } from './components.ts'
import { designBrowser } from './designBrowser.ts'
import { information } from './information.ts'
import { ipLibrary } from './ipLibrary.ts'
import { knowledge } from './knowledge.ts'
import { phaseBoard } from './phaseBoard.ts'
import { phases } from './phases.ts'
import { processLibraries } from './processLibraries.ts'
import { projects } from './projects.ts'
import { scripts } from './scripts.ts'
import { settings } from './settings.ts'
import { sidebar } from './sidebar.ts'
import { theme } from './theme.ts'
import { verification } from './verification.ts'
import { workspace } from './workspace.ts'

export const zhCN = {
  chat,
  common,
  components,
  designBrowser,
  information,
  ipLibrary,
  knowledge,
  phaseBoard,
  phases,
  processLibraries,
  projects,
  scripts,
  settings,
  sidebar,
  theme,
  verification,
  workspace
}

export type Messages = typeof zhCN
