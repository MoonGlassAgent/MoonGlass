/**
 * Pi 运行时物化脚本
 *
 * 背景：pnpm 的 node_modules 是符号链接结构，electron-builder 的 extraResources
 * 只复制 node_modules/@earendil-works/pi-coding-agent 自身（dist + package.json），
 * 其 18 个生产依赖（chalk/undici/pi-ai/pi-agent-core 等）不会进入安装包，
 * 导致打包后 `pi --mode rpc` 启动即崩溃（ERR_MODULE_NOT_FOUND），
 * 表现为「[pi-rpc] 等待就绪超时：[pi-rpc] 进程未启动」。
 *
 * 本脚本把 pi-coding-agent 及其全部传递依赖（含 pnpm 链接的 peer 依赖）
 * 物化为自包含目录 build-resources/pi-runtime/：
 *   dist/  package.json  node_modules/...
 * electron-builder 的 afterPack 钩子将其封装为 resources/pi-runtime.asar，
 * 避免绿色版出现数千个裸露的依赖文件。
 *
 * 依赖收集原理：pnpm 虚拟存储中 <pkg>/node_modules/ 恰好包含该包解析后的全部依赖
 * （含 peer），因此从 pi-coding-agent 的真实路径出发递归列举同级目录即可。
 * 扁平化复制到顶层 node_modules；版本冲突时把后者嵌套到消费方自己的 node_modules 下。
 */

import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync
} from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = process.cwd()
const PI_PKG = join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent')
const OUT = join(ROOT, 'build-resources', 'pi-runtime')

if (!existsSync(PI_PKG)) {
  console.error('[stage-pi] 未找到 node_modules/@earendil-works/pi-coding-agent，请先 pnpm install')
  process.exit(1)
}

const piReal = realpathSync(PI_PKG)
const piPkgJson = JSON.parse(readFileSync(join(piReal, 'package.json'), 'utf-8'))
console.log(`[stage-pi] pi-coding-agent@${piPkgJson.version}  <- ${piReal}`)

// Windows 杀毒软件会瞬时持锁新建文件/目录，rm 偶发 EPERM——Node 内建重试即可覆盖
const RM_OPTS = { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }
rmSync(OUT, RM_OPTS)
mkdirSync(join(OUT, 'node_modules'), { recursive: true })

// pi-coding-agent 本体（仅 dist + package.json，与打包运行时需要的一致）
cpSync(join(piReal, 'dist'), join(OUT, 'dist'), { recursive: true })
cpSync(join(piReal, 'package.json'), join(OUT, 'package.json'))

/** 顶层已物化的依赖 name -> version */
const topLevels = new Map()
/** 已递归处理过的真实路径（防止循环依赖死循环） */
const visited = new Set()
let copied = 0
const conflicts = []

/** 列举 pnpm 虚拟存储中某包的直接依赖真实路径（含 @scope 处理） */
function listStoreDeps(pkgRealDir) {
  const selfName = JSON.parse(readFileSync(join(pkgRealDir, 'package.json'), 'utf-8')).name
  // scoped 包位于 node_modules/@scope/name，node_modules 需上溯两级
  const modulesDir = selfName.startsWith('@') ? dirname(dirname(pkgRealDir)) : dirname(pkgRealDir)
  const deps = []
  for (const entry of readdirSync(modulesDir)) {
    if (entry.startsWith('.') || entry === selfName) continue
    const entryPath = join(modulesDir, entry)
    if (!statSync(entryPath).isDirectory()) continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(entryPath)) {
        const name = `${entry}/${sub}`
        if (name === selfName) continue
        deps.push({ name, path: join(entryPath, sub) })
      }
    } else {
      deps.push({ name: entry, path: entryPath })
    }
  }
  return deps
}

/**
 * 把 pkgRealDir 的直接依赖物化到 destNodeModules（顶层或消费方嵌套）。
 */
function stageDeps(pkgRealDir, consumerDestDir) {
  if (visited.has(pkgRealDir)) return
  visited.add(pkgRealDir)

  for (const dep of listStoreDeps(pkgRealDir)) {
    if (!existsSync(join(dep.path, 'package.json'))) continue
    const depReal = realpathSync(dep.path)
    const version = JSON.parse(readFileSync(join(depReal, 'package.json'), 'utf-8')).version

    const topVersion = topLevels.get(dep.name)
    let destDir
    if (topVersion === undefined) {
      topLevels.set(dep.name, version)
      destDir = join(OUT, 'node_modules', dep.name)
    } else if (topVersion !== version) {
      // 版本冲突：嵌套到消费方自己的 node_modules，保证 Node 就近解析到正确版本
      conflicts.push(`${dep.name}: 顶层 ${topVersion} / 嵌套 ${version} -> ${consumerDestDir}`)
      destDir = join(consumerDestDir, 'node_modules', dep.name)
    } else {
      continue // 同版本已在顶层
    }

    mkdirSync(dirname(destDir), { recursive: true })
    cpSync(depReal, destDir, { recursive: true, dereference: true })
    copied++
    stageDeps(depReal, destDir)
  }
}

stageDeps(piReal, OUT)

// ── 裁剪：删除运行时不需要的文件，降低文件数量（解压/安装速度）────────────
// 类型声明（.d.ts/.d.mts/.d.cts）、sourcemap（.map）仅占位，Node 运行时从不加载；
// test/docs/example 目录同理。裁剪前约 1.9 万文件，裁剪后预期 ~6 千。
const PRUNE_FILE = /\.(map|tsbuildinfo)$|\.d\.(ts|mts|cts)$/
const PRUNE_DIR = new Set(['test', 'tests', '__tests__', 'example', 'examples', 'docs', '.github'])
let pruned = 0
function prune(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (PRUNE_DIR.has(entry.name)) {
        rmSync(p, RM_OPTS)
        pruned++
        continue
      }
      prune(p)
    } else if (PRUNE_FILE.test(entry.name)) {
      rmSync(p, { maxRetries: 8, retryDelay: 300 })
      pruned++
    }
  }
}
prune(join(OUT, 'node_modules'))
console.log(`[stage-pi] 裁剪运行时无关文件 ${pruned} 项`)

// ── 裁剪 src/：仅当包的 main/exports（排除 source 条件）均不引用 src/ 时 ──
// 例如 @mistralai/mistralai 同时发布 esm/ 与 src/，Node 只走 exports.default -> esm/，
// src/ 下上千个 .ts 源文件纯属占位。
function resolveTargets(node, out, skipSource) {
  if (typeof node === 'string') {
    if (!skipSource) out.push(node)
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) resolveTargets(v, out, k === 'source')
  }
}
let prunedSrc = 0
function pruneSrcDirs(modulesDir) {
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const names = entry.name.startsWith('@')
      ? readdirSync(join(modulesDir, entry.name)).map((s) => join(entry.name, s))
      : [entry.name]
    for (const name of names) {
      const dir = join(modulesDir, name)
      const srcDir = join(dir, 'src')
      if (!existsSync(srcDir)) continue
      try {
        const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
        const targets = []
        resolveTargets(p.exports ?? {}, targets, false)
        if (p.main) targets.push(p.main)
        if (p.module) targets.push(p.module)
        if (targets.length > 0 && targets.every((t) => !t.includes('src/'))) {
          rmSync(srcDir, { recursive: true, force: true })
          prunedSrc++
        }
      } catch { /* 保留 */ }
    }
  }
}
pruneSrcDirs(join(OUT, 'node_modules'))
console.log(`[stage-pi] 裁剪不可达 src/ 目录 ${prunedSrc} 个`)

console.log(`[stage-pi] 已物化 ${copied} 个依赖包 -> ${OUT}`)
if (conflicts.length > 0) {
  console.log('[stage-pi] 版本冲突（已嵌套处理）:')
  for (const c of conflicts) console.log('  - ' + c)
}
