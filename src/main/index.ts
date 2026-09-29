/**
 * MoonGlass 主进程入口
 *
 * 启动流程：
 *   创建应用服务注册表 → 注册 IPC → app.ready 后启动全部服务并创建主窗口
 */

import { app, shell, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc-contract'
import { createApplication } from './core/application'
import { registerIpcHandlers } from './ipc'

app.setName('MoonGlass')

/**
 * 绿色版在可执行文件旁放置 portable-mode 标记。必须在创建任何服务前
 * 固定 userData，否则数据库和 Demo 会落到系统用户目录。
 */
const executableDir = dirname(process.execPath)
if (app.isPackaged && existsSync(join(executableDir, 'portable-mode'))) {
  const portableUserData = join(executableDir, 'userdata')
  app.setPath('userData', portableUserData)
  console.log('[moonglass] 便携模式数据目录:', portableUserData)
} else if (!app.isPackaged && process.env.MOONGLASS_USERDATA) {
  // 开发/诊断模式的数据目录隔离（E2E 与性能复现脚本使用，避免触碰真实 userData）
  app.setPath('userData', resolve(process.env.MOONGLASS_USERDATA))
  console.log('[moonglass] 隔离数据目录:', process.env.MOONGLASS_USERDATA)
}

const services = createApplication()
registerIpcHandlers(services)

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'MoonGlass ASIC Design Agent',
    icon: join(__dirname, '../../resources/moonglass/logo.png'),
    backgroundColor: '#f4f4f5',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Agent 流式事件经 webContents 推送给渲染进程
  const wc = win.webContents
  let rendererRecoveryCount = 0
  let unresponsiveRecovery: NodeJS.Timeout | undefined
  wc.on('console-message', (_event, details) => {
    if (details.level === 'error') console.error(`[renderer-console] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })
  wc.on('render-process-gone', (_event, details) => {
    console.error(`[renderer-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
    if (!win.isDestroyed() && rendererRecoveryCount < 1) {
      rendererRecoveryCount += 1
      setTimeout(() => { if (!win.isDestroyed()) wc.reload() }, 500)
    }
  })
  wc.on('unresponsive', () => {
    console.error('[renderer-unresponsive] renderer 未响应，20 秒后仍未恢复将重新加载界面')
    if (unresponsiveRecovery) clearTimeout(unresponsiveRecovery)
    unresponsiveRecovery = setTimeout(() => {
      if (!win.isDestroyed() && !wc.isDestroyed()) {
        console.error('[renderer-unresponsive] 执行界面自动恢复')
        wc.reload()
      }
    }, 20_000)
  })
  wc.on('responsive', () => {
    if (unresponsiveRecovery) clearTimeout(unresponsiveRecovery)
    unresponsiveRecovery = undefined
  })
  services.agent.attachEmitter((projectId, event, sessionName) => {
    if (!wc.isDestroyed()) wc.send(IPC.Agent.Event, { projectId, event, sessionName })
  })

  // 手动界面重载：Ctrl+Shift+R 只刷新渲染进程，主进程内的 Agent 会话（pi 子进程）不受影响。
  // before-input-event 先于页面按键与菜单加速键派发，preventDefault 同时压住默认菜单的
  // 强制刷新（Shift+CmdOrCtrl+R），保证行为一致为普通 reload；不接管默认 Ctrl+R/F5。
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.code === 'KeyR') {
      event.preventDefault()
      console.log('[moonglass] 收到 Ctrl+Shift+R，手动重载界面（进行中的 Agent 会话不受影响）')
      wc.reload()
    }
  })

  // 退出守卫：仍有会话在运行时拦截窗口关闭，由用户确认是否中断。
  // 打包冒烟（MOONGLASS_STARTUP_SMOKE）在创建窗口前已自行退出，不会走到这里；
  // 无运行会话时直接放行。对话框文案为主进程原生 UI，无渲染端 i18n 运行时，保持中文。
  let closeGuardConfirmed = false
  win.on('close', (event) => {
    if (closeGuardConfirmed) return
    const runningProjects = Object.values(services.agent.sessionActivity()).filter((a) => a.running).length
    if (runningProjects === 0) return
    event.preventDefault()
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: '退出 MoonGlass',
      message: `有 ${runningProjects} 个项目的会话正在进行`,
      detail: '退出将中断它们（会话历史保留，可重启后继续）。',
      buttons: ['仍要退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) {
        closeGuardConfirmed = true
        win.close()
      }
    })
  })

  win.on('ready-to-show', () => { rendererRecoveryCount = 0; win.show() })

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.toString())
    } catch {
      // 非法或非网络 URL 一律拒绝。
    }
    return { action: 'deny' }
  })

  // 整窗导航兜底：渲染进程内任何会替换当前页面的跳转都先过这一关。
  // 仅放行应用自身页面（dev server 同源 / 打包后的 index.html）；
  // http(s) 交给系统浏览器，其余（如 md 报告里的相对路径链接漏网时）一律拦截，防止整窗白屏。
  const indexPagePathname = new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).toString()).pathname
  wc.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        if (target.origin === new URL(process.env['ELECTRON_RENDERER_URL']).origin) return
      } else if (target.protocol === 'file:' && target.pathname.toLowerCase() === indexPagePathname.toLowerCase()) {
        return
      }
      event.preventDefault()
      if (target.protocol === 'http:' || target.protocol === 'https:') void shell.openExternal(url)
    } catch {
      event.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.moonglass.asic-design-agent')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await services.lifecycle.startAll()
  console.log('[moonglass] all services started')

  // 绿色版打包冒烟：验证打包后的主进程和全部服务可真实启动，随后自行退出。
  if (process.env['MOONGLASS_STARTUP_SMOKE'] === '1') {
    console.log('[moonglass] packaged startup smoke passed')
    setTimeout(() => app.quit(), 250)
    return
  }

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', async () => {
  // 正常退出必经此处：stopAll 杀掉全部 pi 会话前，先把仍在运行的会话清单
  // 落盘为中断标记（userData/moonglass/interrupted-sessions.json），供下次启动提示"上轮中断"
  services.agent.markInterruptedSessions()
  await services.lifecycle.stopAll()
})
