/**
 * MoonGlass 主进程入口
 *
 * 启动流程：
 *   创建应用服务注册表 → 注册 IPC → app.ready 后启动全部服务并创建主窗口
 */

import { app, shell, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  services.agent.attachEmitter((projectId, event) => {
    if (!wc.isDestroyed()) wc.send(IPC.Agent.Event, { projectId, event })
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
  await services.lifecycle.stopAll()
})
