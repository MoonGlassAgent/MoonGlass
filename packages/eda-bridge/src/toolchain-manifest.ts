/**
 * EDA 工具链版本钉死清单（toolchain manifest）
 *
 * 三个一键安装 bundle 的版本 pin 单一出处：
 * - oss-cad-suite / verible：pin 到具体 GitHub Release tag + 精确资产名 + sha256，
 *   下载走 `releases/download/<tag>/<asset>` 直链（镜像回退由 download.ts 继续生效），
 *   不再查询 releases/latest；
 * - python-cocotb：pip 安装参数 pin 到 cocotb==2.0.1（cocotb-bus/cocotb-coverage 不 pin），
 *   探测与安装后均按 COCOTB_VERSION_RANGE 校验版本。
 *
 * 升级工具链的显式流程：修改本文件中的 pin（tag / assetName / sha256 / cocotb 版本）
 * → 跑 `node scripts/toolchain-manifest-smoke.mjs` 与 `node scripts/run-tests.mjs core`
 * → 按 docs/VERIF-ENV-ZERO-FRICTION-GUIDE-ZH-CN.md §4 重跑验收。
 *
 * 本文件零依赖（仅 Node 内置类型），可被主进程与 eda-bridge 内部共同引用。
 */

/** GitHub Release 资产 pin（精确版本钉死） */
export interface GitHubReleasePin {
  kind: 'github-release'
  /** GitHub 仓库（owner/name） */
  repo: string
  /** 钉死的 release tag */
  pinnedTag: string
  /** 精确资产名（下载 URL 的末段） */
  assetName: string
  /** 资产名校验正则（防御 pin 与资产名漂移） */
  assetNamePattern: RegExp
  /** 资产预期 sha256（hex），下载后必须校验 */
  sha256: string
}

/** pip 安装 pin（cocotb） */
export interface PipPackagePin {
  kind: 'pip'
  /** 钉死的 cocotb 版本 */
  pinnedVersion: string
  /** `pip install` 之后跟随的参数（含 --user/--upgrade 与包规格） */
  pipInstallArgs: string[]
}

/** 按 bundle id 键控的工具链 pin 清单（键与 install-plan.ts 的 INSTALLABLE_BUNDLES 一一对应） */
export interface ToolchainManifest {
  'oss-cad-suite': GitHubReleasePin
  'verible': GitHubReleasePin
  'python-cocotb': PipPackagePin
}

export const TOOLCHAIN_MANIFEST: ToolchainManifest = {
  'oss-cad-suite': {
    kind: 'github-release',
    repo: 'YosysHQ/oss-cad-suite-build',
    pinnedTag: '2026-09-28',
    assetName: 'oss-cad-suite-windows-x64-20260928.tgz',
    assetNamePattern: /^oss-cad-suite-windows-x64-20260928\.tgz$/,
    sha256: '71a0a16592db2070e6abf18f76463dcc6bc0c7d6c772f29a7fd925197a29e184'
  },
  'verible': {
    kind: 'github-release',
    repo: 'chipsalliance/verible',
    pinnedTag: 'v0.0-4296-g0f262651',
    assetName: 'verible-v0.0-4296-g0f262651-win64.zip',
    assetNamePattern: /^verible-v0\.0-4296-g0f262651-win64\.zip$/,
    sha256: '4590841d91dadb108879aa261dbfd7081db06360484a7a21470174bf6fb3cf80'
  },
  'python-cocotb': {
    kind: 'pip',
    pinnedVersion: '2.0.1',
    pipInstallArgs: ['--user', '--upgrade', 'cocotb==2.0.1', 'cocotb-bus', 'cocotb-coverage']
  }
}

/** 构造 GitHub Release 资产的直接下载 URL（供 download.ts 镜像前缀逻辑继续生效） */
export function releaseDownloadUrl(pin: GitHubReleasePin): string {
  return `https://github.com/${pin.repo}/releases/download/${pin.pinnedTag}/${pin.assetName}`
}

/** GitHub Release 页面 URL（安装失败时的手动下载指引） */
export function releasePageUrl(pin: GitHubReleasePin): string {
  return `https://github.com/${pin.repo}/releases/tag/${pin.pinnedTag}`
}

/** cocotb 兼容版本范围（主版本 2.x；运行侧 cocotb_tools.runner 与 2.0 API 绑定） */
export const COCOTB_VERSION_RANGE = '>=2.0.0 <3.0.0'

/** cocotb 版本兼容性判断：解析 semver，主版本 == 2 即兼容；解析失败判不兼容 */
export function isCocotbVersionCompatible(version: string): boolean {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false
  return Number(match[1]) === 2
}
