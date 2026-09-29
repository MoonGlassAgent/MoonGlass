/**
 * 工具链版本 pin 清单 smoke：断言 toolchain-manifest 的形状、URL 构造、
 * cocotb 版本兼容判断，以及 INSTALLABLE_BUNDLES 与 manifest 键的一致性。
 * 纯函数断言，不涉及真实下载/安装链路。
 */

import assert from 'node:assert/strict'
import {
  COCOTB_VERSION_RANGE,
  isCocotbVersionCompatible,
  releaseDownloadUrl,
  releasePageUrl,
  TOOLCHAIN_MANIFEST
} from '../packages/eda-bridge/src/toolchain-manifest.ts'
import { INSTALLABLE_BUNDLES } from '../packages/eda-bridge/src/install-plan.ts'

// 1. 三个 bundle 键齐，且与 INSTALLABLE_BUNDLES 一致
{
  assert.deepEqual(Object.keys(TOOLCHAIN_MANIFEST).sort(), [...INSTALLABLE_BUNDLES].sort())
}

// 2. GitHub Release pin（oss-cad-suite / verible）：tag/asset/sha256 非空且形状正确
for (const id of ['oss-cad-suite', 'verible']) {
  const pin = TOOLCHAIN_MANIFEST[id]
  assert.equal(pin.kind, 'github-release', `${id} 应为 github-release pin`)
  assert.ok(pin.repo.includes('/'), `${id} repo 应为 owner/name`)
  assert.ok(pin.pinnedTag.length > 0, `${id} pinnedTag 非空`)
  assert.ok(pin.assetName.length > 0, `${id} assetName 非空`)
  assert.ok(pin.assetNamePattern.test(pin.assetName), `${id} assetName 应匹配 assetNamePattern`)
  assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${id} sha256 应为 64 位小写 hex`)
  const url = releaseDownloadUrl(pin)
  assert.equal(url, `https://github.com/${pin.repo}/releases/download/${pin.pinnedTag}/${pin.assetName}`, `${id} 下载 URL 构造`)
  assert.ok(url.includes(`/releases/download/${pin.pinnedTag}/`), `${id} URL 含 download/<tag>/`)
  assert.equal(releasePageUrl(pin), `https://github.com/${pin.repo}/releases/tag/${pin.pinnedTag}`, `${id} release 页 URL`)
}

// 3. cocotb pin：pip 参数含 pin 版本与伴随包
{
  const pin = TOOLCHAIN_MANIFEST['python-cocotb']
  assert.equal(pin.kind, 'pip')
  assert.equal(pin.pinnedVersion, '2.0.1')
  assert.ok(pin.pipInstallArgs.includes('--user'))
  assert.ok(pin.pipInstallArgs.includes('--upgrade'))
  assert.ok(pin.pipInstallArgs.includes('cocotb==2.0.1'))
  assert.ok(pin.pipInstallArgs.includes('cocotb-bus'))
  assert.ok(pin.pipInstallArgs.includes('cocotb-coverage'))
  assert.ok(COCOTB_VERSION_RANGE.length > 0)
}

// 4. cocotb 版本兼容判断：2.x 兼容，其余不兼容，解析失败判不兼容
{
  assert.equal(isCocotbVersionCompatible('2.0.1'), true)
  assert.equal(isCocotbVersionCompatible('2.1.0'), true)
  assert.equal(isCocotbVersionCompatible('1.8.0'), false)
  assert.equal(isCocotbVersionCompatible('3.0.0'), false)
  assert.equal(isCocotbVersionCompatible('abc'), false)
}

console.log('toolchain manifest smoke passed: pin 清单形状、URL 构造、cocotb 版本判断、bundle 键一致性 OK')
