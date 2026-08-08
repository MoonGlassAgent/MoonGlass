/**
 * electron-builder afterPack 钩子
 *
 * 把 scripts/stage-pi-runtime.mjs 物化的 pi 运行时（含全部 node_modules 依赖）
 * 封装为单一 resources/pi-runtime.asar。
 *
 * 为什么不走 extraResources：electron-builder 的文件匹配器会丢弃
 * extraResources 里的 node_modules 目录，导致 pi 子进程缺依赖崩溃
 * （“[pi-rpc] 等待就绪超时：[pi-rpc] 进程未启动”）。
 */

const { existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { createPackage } = require('@electron/asar')

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const src = join(context.packager.projectDir, 'build-resources', 'pi-runtime')
  if (!existsSync(join(src, 'dist', 'cli.js'))) {
    throw new Error('[afterPack] build-resources/pi-runtime 不存在，请先运行 node scripts/stage-pi-runtime.mjs')
  }
  // Windows: <appOutDir>/resources；macOS: <appOutDir>/MoonGlass.app/Contents/Resources
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  const legacyDest = join(resourcesDir, 'pi-coding-agent')
  const dest = join(resourcesDir, 'pi-runtime.asar')
  rmSync(legacyDest, { recursive: true, force: true })
  rmSync(dest, { force: true })
  await createPackage(src, dest)
  if (!existsSync(dest)) throw new Error('[afterPack] pi-runtime.asar 生成失败')
  console.log(`[afterPack] pi 运行时已封装为 ${dest}`)
}
