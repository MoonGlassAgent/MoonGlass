/**
 * 桌面通知服务（长程任务待人提醒）
 *
 * 长程任务期间用户不常看窗口：当验证运行循环暂停待人（LLM 决策提案待审批 /
 * 熔断待人处置 / 门禁未通过）或 Agent 发出结构化决策请求时，由 AgentService
 * 四个触发点调用 notifyHumanAttention() 发系统桌面通知，提醒用户回来处理；
 * 点击通知聚焦主窗口。窗口已聚焦（用户正在看，界面内有显性入口）时不弹。
 *
 * 节流语义见 HumanAttentionThrottle：同一项目同一 kind 在一次"待人 episode"
 * 内只弹一次；episode 以新的暂停 since / 新决策请求 id 区分（恢复运行后再次
 * 暂停即新 episode，可再弹）；用户回到窗口（聚焦）时清空全部 episode。
 * Electron Notification 不可用的环境（极少数 Linux 无通知服务）静默降级，不抛错。
 */

import { BrowserWindow, Notification, app } from 'electron'
import type { MoonGlassService } from '../core/lifecycle.ts'

/** 待人事件类型（与 AgentService 触发点一一对应，只在这四类发桌面通知） */
export type HumanAttentionKind = 'llm-decision-pending' | 'paused-breaker' | 'decision-request' | 'gate-blocked'

/** 各类型在通知标题中的中文短标签 */
const KIND_LABELS: Record<HumanAttentionKind, string> = {
  'llm-decision-pending': '验证决策待批准',
  'paused-breaker': '验证循环熔断待人处置',
  'decision-request': '决策请求待处置',
  'gate-blocked': '门禁未通过待人处置'
}

/** 桌面通知构造选项 */
export interface DesktopNotificationOptions {
  title: string
  body: string
  onClick?: () => void
}

/** 桌面通知句柄最小形状（Electron Notification 满足该结构） */
export interface DesktopNotificationHandle {
  show(): void
}

/**
 * 桌面通知构造器（可注入假实现供冒烟测试）：返回 null 表示当前环境
 * 不支持桌面通知（静默降级，调用方不弹）。
 */
export type DesktopNotifierFactory = (options: DesktopNotificationOptions) => DesktopNotificationHandle | null

/**
 * 待人通知节流器（纯逻辑、无 Electron 依赖、时钟可注入，供 smoke 直测）：
 * 同一项目同一 kind 在一次"待人 episode"内只放行一次通知。
 * episode 由调用方以 episodeKey 标识——新的暂停 since / 新决策请求 id 等，
 * episodeKey 变化即视为新 episode；用户回到窗口（聚焦）或项目恢复运行后
 * 由 NotificationService 调 clearProject/clearAll 解除，下次待人可再弹。
 */
export class HumanAttentionThrottle {
  private readonly episodes = new Map<string, string>()
  /** 每个节流槽最近一次放行的时钟读数（供观测/测试断言） */
  private readonly firedAt = new Map<string, number>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** 同一 episodeKey 重复调用只放行首次；返回 true 表示本次应弹通知 */
  shouldNotify(projectId: string, kind: string, episodeKey: string): boolean {
    const slot = `${projectId}::${kind}`
    if (this.episodes.get(slot) === episodeKey) return false
    this.episodes.set(slot, episodeKey)
    this.firedAt.set(slot, this.now())
    return true
  }

  /** 解除单个项目的全部 episode（该项目恢复运行后调用） */
  clearProject(projectId: string): void {
    const prefix = `${projectId}::`
    for (const key of [...this.episodes.keys()]) {
      if (key.startsWith(prefix)) {
        this.episodes.delete(key)
        this.firedAt.delete(key)
      }
    }
  }

  /** 解除全部 episode（用户回到窗口聚焦时调用） */
  clearAll(): void {
    this.episodes.clear()
    this.firedAt.clear()
  }
}

export interface NotificationServiceOptions {
  /** 项目名解析（通知标题用）；缺省直接显示项目 id */
  resolveProjectName?: (projectId: string) => string
  /** 桌面通知构造器；缺省为 Electron Notification */
  createDesktopNotification?: DesktopNotifierFactory
  /** 节流器（可注入带假时钟的实例） */
  throttle?: HumanAttentionThrottle
  /** 窗口聚焦探测；缺省检查所有 BrowserWindow（测试注入） */
  isWindowFocused?: () => boolean
  /** 点击通知后的聚焦动作；缺省聚焦主窗口（测试注入） */
  focusMainWindow?: () => void
}

/** 缺省桌面通知构造器：Electron Notification 不可用的环境返回 null（静默降级） */
const defaultDesktopNotifierFactory: DesktopNotifierFactory = ({ title, body, onClick }) => {
  if (typeof Notification === 'undefined' || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
    return null
  }
  const notification = new Notification({ title, body })
  if (onClick) notification.on('click', onClick)
  return notification
}

/** 缺省聚焦动作：还原最小化窗口并聚焦最前面的主窗口 */
function focusMainWindowDefault(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export class NotificationService implements MoonGlassService {
  readonly name = 'notification-service'
  private readonly throttle: HumanAttentionThrottle
  private readonly resolveProjectName: (projectId: string) => string
  private readonly createDesktopNotification: DesktopNotifierFactory
  private readonly isWindowFocused: () => boolean
  private readonly focusMainWindow: () => void

  constructor(options: NotificationServiceOptions = {}) {
    this.throttle = options.throttle ?? new HumanAttentionThrottle()
    this.resolveProjectName = options.resolveProjectName ?? ((projectId) => projectId)
    this.createDesktopNotification = options.createDesktopNotification ?? defaultDesktopNotifierFactory
    this.isWindowFocused = options.isWindowFocused ?? (() => BrowserWindow.getAllWindows().some((win) => win.isFocused()))
    this.focusMainWindow = options.focusMainWindow ?? focusMainWindowDefault
  }

  start(): void {
    // 用户回到任一窗口即解除全部待人 episode：窗口内已有决策卡片等显性入口，无需再弹
    for (const win of BrowserWindow.getAllWindows()) win.on('focus', this.handleWindowFocus)
    app.on('browser-window-created', this.handleWindowCreated)
  }

  stop(): void {
    app.removeListener('browser-window-created', this.handleWindowCreated)
    for (const win of BrowserWindow.getAllWindows()) win.removeListener('focus', this.handleWindowFocus)
    this.throttle.clearAll()
  }

  private readonly handleWindowFocus = (): void => {
    this.throttle.clearAll()
  }

  private readonly handleWindowCreated = (_event: unknown, window: BrowserWindow): void => {
    window.on('focus', this.handleWindowFocus)
  }

  /**
   * 发一条"待人"桌面通知（AgentService 四类触发点调用）。
   * summary 为一行中文摘要；episodeKey 标识本次待人 episode（新暂停 since /
   * 新决策请求 id），同一 episode 内去重；窗口聚焦（用户正在看）时不弹。
   * 任何失败（通知服务不可用 / 构造异常）静默降级，不影响调用方主流程。
   */
  notifyHumanAttention(projectId: string, kind: HumanAttentionKind, summary: string, episodeKey: string): void {
    try {
      if (!this.throttle.shouldNotify(projectId, kind, episodeKey)) return
      if (this.isWindowFocused()) return
      const projectName = this.resolveProjectName(projectId)
      const title = `MoonGlass：${KIND_LABELS[kind]}（${projectName}）`
      const desktopNotification = this.createDesktopNotification({
        title,
        body: summary,
        onClick: () => this.focusMainWindow()
      })
      desktopNotification?.show()
    } catch (error) {
      console.warn('[notification-service] 桌面通知发送失败，已静默降级：', error)
    }
  }

  /** 解除单个项目的 episode（供"项目恢复 running"语义调用；当前主要由聚焦解除与 episodeKey 换代覆盖） */
  clearProjectEpisodes(projectId: string): void {
    this.throttle.clearProject(projectId)
  }
}
