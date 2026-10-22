/**
 * 修复被默认名覆盖的会话名（一次性数据修复脚本）
 *
 * 背景：spawnSession 曾对一切会话传 `--name "<项目> / <阶段>"`，pi 启动时会把它
 * 追加为新的 session_info，导致任务会话（"任务 xxx"/自定义名）在磁盘上的最后一条
 * session_info 被默认名覆盖，重启后 listSessions 按最后一条取名 → 会话名"变了"。
 * （源头已修：spawnSession 现在沿用磁盘已有标签。）
 *
 * 策略：对每个会话 JSONL，若存在多条 session_info 且最后一条命中默认名模式
 * （"<任意> / <PHASE>"）而第一条不同，则追加一条以第一条名字为准的纠正 session_info
 * （parentId 指向文件末条目的 id）。改动前把原文件备份为 <file>.bak.jsonl。
 *
 * 用法：先完全退出 MoonGlass，再运行
 *   node scripts/repair-session-names.mjs          # 预演（只打印）
 *   node scripts/repair-session-names.mjs --apply  # 实际修复
 * 可选：--userData <dir> 指定数据目录（默认 %APPDATA%/MoonGlass）
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const APPLY = process.argv.includes('--apply')
const udIdx = process.argv.indexOf('--userData')
const userData = udIdx !== -1 && process.argv[udIdx + 1]
  ? process.argv[udIdx + 1]
  : join(process.env.APPDATA ?? '', 'MoonGlass')
const sessionsRoot = join(userData, 'moonglass', 'pi-sessions')

// spawnSession 历史默认名：`<项目名> / <阶段>`
const DEFAULT_NAME = /^.+ \/ (REQ_SPEC|ARCH|RTL|VERIF|QA|SYNTH)$/
// 旧版"单会话跨阶段"的 session.jsonl 两端都是斜杠式默认名（含 REQ 等历史缩写），
// 此时最后一条更接近最终阶段，不得回滚——首条命中此形状则不修
const LEGACYISH_NAME = /^.+ \/ [A-Z_]+$/
// 逻辑名时代的默认标签（phase-rtl 等）同样不是用户自定义名，不修
const LOGICAL_DEFAULT = /^phase-/

if (!existsSync(sessionsRoot)) {
  console.log(`会话目录不存在：${sessionsRoot}`)
  process.exit(0)
}

let scanned = 0
let repaired = 0
let pending = 0
for (const projectDir of readdirSync(sessionsRoot, { withFileTypes: true })) {
  if (!projectDir.isDirectory()) continue
  const dir = join(sessionsRoot, projectDir.name)
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl') || file.endsWith('.bak.jsonl')) continue
    const path = join(dir, file)
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter((l) => l.trim())
    const entries = []
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch { /* 忽略损坏行 */ }
    }
    const infos = entries.filter((e) => e.type === 'session_info' && typeof e.name === 'string')
    if (infos.length < 2) continue
    scanned += 1
    const firstName = infos[0].name
    const lastName = infos[infos.length - 1].name
    // 仅修复"自定义名被默认名覆盖"：末条是默认名，且首条既不是斜杠式默认名也不是逻辑名
    if (firstName === lastName || !DEFAULT_NAME.test(lastName) || LEGACYISH_NAME.test(firstName) || LOGICAL_DEFAULT.test(firstName)) continue
    // 末条目 id 作为 parentId，保持父链完整
    const lastWithId = [...entries].reverse().find((e) => typeof e.id === 'string')
    const fix = {
      type: 'session_info',
      id: randomUUID().slice(0, 8),
      parentId: lastWithId?.id ?? null,
      timestamp: new Date().toISOString(),
      name: firstName
    }
    console.log(`${APPLY ? '修复' : '[预演] 将修复'} ${projectDir.name}/${file}: "${lastName}" -> "${firstName}"`)
    if (APPLY) {
      copyFileSync(path, path.replace(/\.jsonl$/, '.bak.jsonl'))
      appendFileSync(path, `${JSON.stringify(fix)}\n`, 'utf-8')
      repaired += 1
    } else {
      pending += 1
    }
  }
}
console.log(`\n扫描到 ${scanned} 个多 session_info 文件，${APPLY ? `已修复 ${repaired} 个（原件备份为 .bak.jsonl）` : `待修复 ${pending} 个（加 --apply 实际执行）`}`)
