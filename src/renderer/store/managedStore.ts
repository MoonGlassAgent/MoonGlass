/**
 * 一键托管运行状态（zustand）
 *
 * 托管循环由 WorkspacePage 在渲染进程内编排，离开工作区后循环仍继续执行。
 * 该状态提升到模块级 store，供项目列表页卡片显示「托管中」徽标；
 * 应用重启后托管循环随之终止，状态不持久化，语义一致。
 */

import { create } from 'zustand'
import type { Phase } from '@shared/types'

export interface ManagedRunInfo {
  running: boolean
  /** 当前执行到的阶段（循环推进时更新） */
  phase?: Phase
  /** 托管终点阶段 */
  targetPhase: Phase
  startedAt: string
}

interface ManagedState {
  byProject: Record<string, ManagedRunInfo>
  start: (projectId: string, targetPhase: Phase) => void
  setPhase: (projectId: string, phase: Phase) => void
  finish: (projectId: string) => void
}

export const useManagedStore = create<ManagedState>((set) => ({
  byProject: {},
  start: (projectId, targetPhase) => set((state) => ({
    byProject: { ...state.byProject, [projectId]: { running: true, targetPhase, startedAt: new Date().toISOString() } }
  })),
  setPhase: (projectId, phase) => set((state) => {
    const current = state.byProject[projectId]
    if (!current) return state
    return { byProject: { ...state.byProject, [projectId]: { ...current, phase } } }
  }),
  finish: (projectId) => set((state) => {
    if (!(projectId in state.byProject)) return state
    const next = { ...state.byProject }
    delete next[projectId]
    return { byProject: next }
  })
}))
