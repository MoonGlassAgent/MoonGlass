/**
 * electron-builder afterPack 钩子
 *
 * 把 scripts/stage-pi-runtime.mjs 物化的 pi 运行时（含全部 node_modules 依赖）
 * 复制到打包产物的 resources/pi-coding-agent。
 *
 * 为什么不走 extraResources：electron-builder 的文件匹配器会丢弃
 * extraResources 里的 node_modules 目录，导致 pi 子进程缺依赖崩溃
 * （“[pi-rpc] 等待就绪超时：[pi-rpc] 进程未启动”）。
 */

const { cpSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')

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
  const dest = join(resourcesDir, 'pi-coding-agent')
  rmSync(dest, { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  if (!existsSync(join(dest, 'node_modules', 'undici', 'package.json'))) {
    throw new Error('[afterPack] pi 运行时依赖复制不完整（缺少 node_modules/undici）')
  }
  console.log(`[afterPack] pi 运行时已注入 ${dest}`)
}
