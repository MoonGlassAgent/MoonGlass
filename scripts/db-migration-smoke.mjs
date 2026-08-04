/**
 * 数据库迁移与 ProjectService 冒烟脚本
 *
 * 验证：
 * 1. SQLite 数据库初始化与表创建
 * 2. ProjectService CRUD 走数据库
 * 3. 从 legacy projects.json 自动迁移（临时创建后清理）
 *
 * 运行：node scripts/db-migration-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 动态导入，确保 ts-alias-hooks 已注册
const { DbService } = await import('../src/main/services/DbService.ts')
const { ProjectService } = await import('../src/main/services/ProjectService.ts')
const { closeDatabase } = await import('../src/main/data/connection.ts')

// 用临时目录作为 userData，避免污染真实环境
const fakeUserData = mkdtempSync(join(tmpdir(), 'moonglass-db-smoke-'))

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const dbService = new DbService(fakeUserData)
dbService.start()

const projectService = new ProjectService(dbService, fakeUserData)
projectService.start()

// 1. 创建项目
check('数据库文件已创建', existsSync(join(fakeUserData, 'moonglass', 'moonglass.db')))

const created = projectService.create({ name: 'DB_Smoke_Test', description: 'test' })
check('创建项目成功', created.name === 'DB_Smoke_Test')
check('初始阶段为 REQ_SPEC', created.currentPhase === 'REQ_SPEC')

// 2. 读取
const fetched = projectService.get(created.id)
check('读取项目成功', fetched?.id === created.id && fetched.phases.REQ_SPEC.status === 'active')

// 3. 列表
const list = projectService.list()
check('列表包含新项目', list.length === 1 && list[0].id === created.id)

// 4. 更新
const updated = projectService.update(created.id, { description: 'updated' })
check('更新项目成功', updated?.description === 'updated')

// 5. 阶段推进模拟（save）
updated.currentPhase = 'ARCH'
updated.phases.REQ_SPEC.status = 'completed'
updated.phases.ARCH.status = 'active'
projectService.save(updated)
const afterAdvance = projectService.get(created.id)
check('阶段推进已落库', afterAdvance?.currentPhase === 'ARCH' && afterAdvance.phases.REQ_SPEC.status === 'completed')

// 6. 删除
const deleted = projectService.delete(created.id)
check('删除项目成功', deleted === true && projectService.list().length === 0)

// 7. JSON 迁移测试
const legacyPath = join(fakeUserData, 'moonglass', 'projects.json')
const legacyProject = {
  id: 'legacy-uuid-001',
  name: 'Legacy Project',
  description: 'from json',
  currentPhase: 'RTL',
  phases: created.phases,
  edaToolchain: 'verilator-yosys',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}
writeFileSync(legacyPath, JSON.stringify({ projects: [legacyProject] }, null, 2))

// 重新创建服务实例触发迁移
const db2 = new DbService(fakeUserData)
db2.start()
const ps2 = new ProjectService(db2, fakeUserData)
ps2.start()

const migrated = ps2.get('legacy-uuid-001')
check('legacy JSON 迁移成功', migrated?.name === 'Legacy Project' && migrated.currentPhase === 'RTL')
check('legacy 文件已重命名', !existsSync(legacyPath) && existsSync(`${legacyPath}.legacy`))

// 清理
dbService.stop()
db2.stop()
closeDatabase()
rmSync(fakeUserData, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '✅ 数据库迁移冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
