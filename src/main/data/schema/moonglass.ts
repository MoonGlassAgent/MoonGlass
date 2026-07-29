/**
 * MoonGlass 数据库 Schema（drizzle-orm / SQLite）
 *
 * 依据规格书 §4 独立实现。骨架阶段仅作类型与结构定义，
 * 数据库接线（better-sqlite3 + 迁移）留待 Phase 1 后续完成，
 * 当前项目数据由 ProjectService 的 JSON 文件存储承载。
 */

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

const PHASE_ENUM = ['REQ', 'SPEC', 'ARCH', 'RTL', 'VERIF', 'QA', 'SYNTH'] as const

// ==================== 芯片项目 ====================
export const chipProjects = sqliteTable('chip_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  currentPhase: text('current_phase', { enum: PHASE_ENUM }).notNull().default('REQ'),

  // 工程配置
  edaToolchain: text('eda_toolchain').default('verilator-yosys'),
  targetProcess: text('target_process'),
  targetFrequency: real('target_frequency'), // MHz
  targetArea: real('target_area'), // mm²
  targetPower: real('target_power'), // mW

  // Git 集成
  gitRepoUrl: text('git_repo_url'),
  gitBranch: text('git_branch').default('main'),

  // 项目约束
  companyRulesId: text('company_rules_id'),
  customPromptId: text('custom_prompt_id'),

  // 元数据
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  createdBy: text('created_by').default('user'),
  status: text('status', { enum: ['active', 'archived', 'deleted'] }).default('active')
})

// ==================== 阶段交付物 ====================
export const phaseDeliverables = sqliteTable('phase_deliverables', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .references(() => chipProjects.id)
    .notNull(),
  phase: text('phase', { enum: PHASE_ENUM }).notNull(),

  type: text('type', { enum: ['doc', 'code', 'script', 'report', 'diagram', 'constraint'] }).notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),

  // 版本与状态
  status: text('status', { enum: ['draft', 'reviewing', 'approved', 'rejected'] }).default('draft'),
  version: integer('version').default(1),
  generatedBy: text('generated_by', { enum: ['human', 'agent', 'hybrid'] }).default('human'),

  // 审查信息
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewNotes: text('review_notes'),

  // Git 关联
  gitCommit: text('git_commit'),

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== 门禁检查结果 ====================
export const gateChecks = sqliteTable('gate_checks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .references(() => chipProjects.id)
    .notNull(),
  phase: text('phase', { enum: PHASE_ENUM }).notNull(),

  checkId: text('check_id').notNull(),
  checkName: text('check_name').notNull(),
  checkType: text('check_type', {
    enum: ['lint', 'cdc', 'rdc', 'synthesis', 'coverage', 'review', 'custom']
  }).notNull(),

  passed: integer('passed', { mode: 'boolean' }).notNull(),
  severity: text('severity', { enum: ['error', 'warning', 'info'] }).default('info'),
  message: text('message'),
  details: text('details'), // JSON 详细结果

  autoFixable: integer('auto_fixable', { mode: 'boolean' }).default(false),
  autoFixed: integer('auto_fixed', { mode: 'boolean' }).default(false),
  fixedBy: text('fixed_by'),

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== Agent 对话记录 ====================
export const agentConversations = sqliteTable('agent_conversations', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .references(() => chipProjects.id)
    .notNull(),
  phase: text('phase').notNull(),

  // 模型信息
  modelId: text('model_id').notNull(),
  providerId: text('provider_id').notNull(),

  // 对话内容
  messages: text('messages', { mode: 'json' }).notNull(),
  toolCalls: text('tool_calls', { mode: 'json' }),

  // 上下文快照
  contextSnapshot: text('context_snapshot', { mode: 'json' }),

  // 性能指标
  tokenUsage: text('token_usage', { mode: 'json' }),
  latency: integer('latency'), // ms

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== 提示词模板 ====================
export const promptTemplates = sqliteTable('prompt_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  level: text('level', { enum: ['global', 'phase', 'project', 'security'] }).notNull(),
  phase: text('phase', { enum: PHASE_ENUM }),
  content: text('content').notNull(),
  injectMode: text('inject_mode', { enum: ['prepend', 'append', 'wrap'] }).default('prepend'),
  version: text('version').default('1.0.0'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})
