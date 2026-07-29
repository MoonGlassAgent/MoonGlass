/**
 * 全局轻量状态（zustand）
 */

import { create } from 'zustand'
import type { ChipProject } from '@shared/types'

interface AppState {
  projects: ChipProject[]
  currentProjectId: string | null
  setProjects: (projects: ChipProject[]) => void
  setCurrentProject: (id: string | null) => void
  refreshProjects: () => Promise<void>
}

export const useAppStore = create<AppState>((set) => ({
  projects: [],
  currentProjectId: null,
  setProjects: (projects) => set({ projects }),
  setCurrentProject: (id) => set({ currentProjectId: id }),
  refreshProjects: async () => {
    const projects = await window.moonglass.project.list()
    set({ projects })
  }
}))
