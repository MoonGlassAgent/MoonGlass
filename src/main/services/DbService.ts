/**
 * 数据库生命周期服务
 *
 * 负责打开 SQLite 连接、执行迁移、关闭连接。
 * 其他服务通过 createDatabase() 获取 drizzle 实例进行 CRUD。
 */

import type { MoonGlassDatabase } from '../data/connection.ts'
import { createDatabase, closeDatabase, getDatabasePath, getSqliteInstance } from '../data/connection.ts'
import { migrateDatabase } from '../data/migrate.ts'
import type { MoonGlassService } from '../core/lifecycle.ts'

export class DbService implements MoonGlassService {
  readonly name = 'db-service'

  private database: MoonGlassDatabase | null = null
  private dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  start(): void {
    const dbPath = getDatabasePath(this.dataDir)
    this.database = createDatabase(dbPath)
    migrateDatabase(getSqliteInstance())
    console.log('[db-service] SQLite 数据库已初始化:', dbPath)
  }

  stop(): void {
    closeDatabase()
    this.database = null
  }

  getDb(): MoonGlassDatabase {
    if (!this.database) throw new Error('[db-service] 数据库未初始化')
    return this.database
  }
}
