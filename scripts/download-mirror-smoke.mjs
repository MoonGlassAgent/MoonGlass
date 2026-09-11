/**
 * GitHub 下载镜像回退 smoke：断言候选列表生成与回退/清理逻辑。
 * 使用注入的假 fetcher，不涉及真实网络（真实链路另有一次性验证脚本实测）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { githubDownloadCandidates, downloadFileWithMirrors, fetchWithMirrors } from '../packages/eda-bridge/src/download.ts'

const URL = 'https://github.com/chipsalliance/verible/releases/download/v0.0-4023/verible-v0.0-4023-win64.zip'
const workDir = mkdtempSync(join(tmpdir(), 'moonglass-download-mirror-smoke-'))

const okResponse = (text) => new Response(Readable.toWeb(Readable.from([Buffer.from(text)])))

try {
  // 1. 缺省候选：直连在前，gh-proxy.com / ghproxy.net 在后
  {
    delete process.env.MOONGLASS_GITHUB_MIRRORS
    assert.deepEqual(githubDownloadCandidates(URL), [
      URL,
      `https://gh-proxy.com/${URL}`,
      `https://ghproxy.net/${URL}`
    ])
  }

  // 2. 环境变量 MOONGLASS_GITHUB_MIRRORS 覆盖缺省镜像（逗号分隔、去空白）
  {
    process.env.MOONGLASS_GITHUB_MIRRORS = ' https://mirror-a.example/ , https://mirror-b.example/ '
    assert.deepEqual(githubDownloadCandidates(URL), [
      URL,
      `https://mirror-a.example/${URL}`,
      `https://mirror-b.example/${URL}`
    ])
    delete process.env.MOONGLASS_GITHUB_MIRRORS
  }

  // 3. 直连成功 → 用直连通道，不触碰镜像
  {
    const dest = join(workDir, 'direct.zip')
    const seen = []
    const fetcher = async (candidate) => {
      assert.equal(candidate, URL)
      return okResponse('direct-payload')
    }
    const result = await downloadFileWithMirrors(URL, dest, { fetcher, onChannel: (ch) => seen.push(ch) })
    assert.equal(result.channel, '直连 GitHub')
    assert.equal(readFileSync(dest, 'utf8'), 'direct-payload')
    assert.deepEqual(seen, ['直连 GitHub'])
  }

  // 4. 直连失败 → 回退镜像成功，通道名为 '镜像 gh-proxy.com'
  {
    const dest = join(workDir, 'mirror.zip')
    const seen = []
    const fetcher = async (candidate) => {
      if (candidate === URL) throw new Error('fetch failed')
      return okResponse('mirror-payload')
    }
    const result = await downloadFileWithMirrors(URL, dest, { fetcher, onChannel: (ch) => seen.push(ch) })
    assert.equal(result.channel, '镜像 gh-proxy.com')
    assert.equal(readFileSync(dest, 'utf8'), 'mirror-payload')
    assert.deepEqual(seen, ['直连 GitHub', '镜像 gh-proxy.com'])
  }

  // 5. 全部失败 → 汇总错误含原始地址，且不残留半成品文件
  {
    const dest = join(workDir, 'all-fail.zip')
    const fetcher = async () => { throw new Error('fetch failed') }
    await assert.rejects(
      downloadFileWithMirrors(URL, dest, { fetcher }),
      (error) => {
        assert.match(error.message, /GitHub 直连与镜像均不可达（网络限制）/)
        assert.ok(error.message.includes(`原始地址：${URL}`))
        return true
      }
    )
    assert.equal(existsSync(dest), false)
  }

  // 6. 传输中途断流（半成品）→ 每轮失败都清理半成品，最终抛汇总错误
  {
    const dest = join(workDir, 'partial.zip')
    const fetcher = async () => new Response(Readable.toWeb(new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('connection reset'))
      }
    })))
    await assert.rejects(downloadFileWithMirrors(URL, dest, { fetcher }), /GitHub 直连与镜像均不可达/)
    assert.equal(existsSync(dest), false)
  }

  // 7. HTTP 非 ok 也视为失败并回退（镜像 404 等场景）
  {
    const dest = join(workDir, 'http-fail.zip')
    const fetcher = async (candidate) => {
      if (candidate === URL) return new Response('not found', { status: 404 })
      return okResponse('from-mirror')
    }
    const result = await downloadFileWithMirrors(URL, dest, { fetcher })
    assert.equal(result.channel, '镜像 gh-proxy.com')
    assert.equal(readFileSync(dest, 'utf8'), 'from-mirror')
  }

  // 8. fetchWithMirrors（元数据查询用）：直连失败回退镜像，返回 response + channel
  {
    const fetcher = async (candidate) => {
      if (candidate === URL) throw new Error('fetch failed')
      return okResponse('{"tag_name":"v0.0"}')
    }
    const { response, channel } = await fetchWithMirrors(URL, { fetcher })
    assert.equal(channel, '镜像 gh-proxy.com')
    assert.deepEqual(await response.json(), { tag_name: 'v0.0' })
    await assert.rejects(fetchWithMirrors(URL, { fetcher: async () => { throw new Error('down') } }), /GitHub 直连与镜像均不可达/)
  }
} finally {
  delete process.env.MOONGLASS_GITHUB_MIRRORS
  rmSync(workDir, { recursive: true, force: true })
}

console.log('download mirror smoke passed: candidates & fallback & cleanup assertions OK')
