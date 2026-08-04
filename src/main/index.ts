/**
 * MoonGlass 主进程入口
 *
 * 启动流程：
 *   创建应用服务注册表 → 注册 IPC → app.ready 后启动全部服务并创建主窗口
 */

import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc-contract'
import { createApplication } from './core/application'
import { registerIpcHandlers } from './ipc'

app.setName('MoonGlass')
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
  services.agent.attachEmitter((projectId, event) => {
    if (!wc.isDestroyed()) wc.send(IPC.Agent.Event, { projectId, event })
  })

  win.on('ready-to-show', () => win.show())

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
