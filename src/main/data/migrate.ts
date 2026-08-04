/**
 * MoonGlass 数据库迁移
 *
 * 基于 SQLite user_version pragma 的版本化迁移。
 * 当前为 Phase 1 首次接线，创建 schema 中定义的全部表。
 */

import type { Database } from 'better-sqlite3'

const CURRENT_VERSION = 2

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS chip_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        current_phase TEXT NOT NULL DEFAULT 'REQ_SPEC',
        eda_toolchain TEXT DEFAULT 'verilator-yosys',
        target_process TEXT,
        target_frequency REAL,
        target_area REAL,
        target_power REAL,
        git_repo_url TEXT,
        git_branch TEXT DEFAULT 'main',
        company_rules_id TEXT,
        custom_prompt_id TEXT,
        phases_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_by TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS phase_deliverables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chip_projects(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        version INTEGER DEFAULT 1,
        generated_by TEXT DEFAULT 'human',
        reviewed_by TEXT,
        reviewed_at INTEGER,
        review_notes TEXT,
        git_commit TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_deliverables_project_phase
        ON phase_deliverables(project_id, phase);

      CREATE TABLE IF NOT EXISTS gate_checks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chip_projects(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        check_id TEXT NOT NULL,
        check_name TEXT NOT NULL,
        check_type TEXT NOT NULL,
        passed INTEGER NOT NULL,
        severity TEXT DEFAULT 'info',
        message TEXT,
        details TEXT,
        auto_fixable INTEGER DEFAULT 0,
        auto_fixed INTEGER DEFAULT 0,
        fixed_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_gate_checks_project_phase
        ON gate_checks(project_id, phase);

      CREATE TABLE IF NOT EXISTS agent_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chip_projects(id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        messages TEXT NOT NULL,
        tool_calls TEXT,
        context_snapshot TEXT,
        token_usage TEXT,
        latency INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_agent_conversations_project_phase
        ON agent_conversations(project_id, phase);

      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        level TEXT NOT NULL,
        phase TEXT,
        content TEXT NOT NULL,
        inject_mode TEXT DEFAULT 'prepend',
        version TEXT DEFAULT '1.0.0',
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `
  },
  {
    version: 2,
    sql: `
      UPDATE chip_projects SET current_phase = 'REQ_SPEC' WHERE current_phase IN ('REQ', 'SPEC');
      UPDATE phase_deliverables SET phase = 'REQ_SPEC' WHERE phase IN ('REQ', 'SPEC');
      UPDATE gate_checks SET phase = 'REQ_SPEC' WHERE phase IN ('REQ', 'SPEC');
      UPDATE agent_conversations SET phase = 'REQ_SPEC' WHERE phase IN ('REQ', 'SPEC');
      UPDATE prompt_templates SET phase = 'REQ_SPEC' WHERE phase IN ('REQ', 'SPEC');
    `
  }
]

export function migrateDatabase(sqlite: Database): void {
  sqlite.prepare('PRAGMA foreign_keys = ON').run()

  const version = sqlite.prepare<{ user_version: number }[], { user_version: number }>('PRAGMA user_version').get()?.user_version ?? 0

  for (const migration of MIGRATIONS) {
    if (migration.version > version) {
      sqlite.exec(migration.sql)
      sqlite.prepare(`PRAGMA user_version = ${migration.version}`).run()
      console.log(`[database] migrated to version ${migration.version}`)
    }
  }
}
