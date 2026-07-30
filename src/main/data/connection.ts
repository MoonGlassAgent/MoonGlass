/**
 * MoonGlass SQLite 数据库连接
 *
 * 使用 better-sqlite3 + drizzle-orm。
 * 数据库文件路径由调用方注入（生产环境来自 app.getPath('userData')），
 * 便于在 Node 冒烟测试中传入临时目录。
 */

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema/moonglass.ts'

export type MoonGlassDatabase = ReturnType<typeof drizzle<typeof schema>>

let sqlite: Database.Database | null = null
let db: MoonGlassDatabase | null = null

/** 根据数据目录生成默认数据库路径 */
export function getDatabasePath(dataDir: string): string {
  return `${dataDir}/moonglass/moonglass.db`
}

export function createDatabase(dbPath: string): MoonGlassDatabase {
  if (db) return db

  mkdirSync(dirname(dbPath), { recursive: true })

  sqlite = new Database(dbPath)
  // WAL 模式提升并发写入性能
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })
  return db
}

/** 获取底层 better-sqlite3 实例（用于迁移脚本） */
export function getSqliteInstance(): Database.Database {
  if (!sqlite) throw new Error('[database] 数据库未初始化')
  return sqlite
}

export function closeDatabase(): void {
  if (sqlite) {
    sqlite.close()
    sqlite = null
  }
  db = null
}
