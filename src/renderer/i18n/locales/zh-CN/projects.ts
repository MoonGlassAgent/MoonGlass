/** 项目列表页与项目卡片文案（ProjectsPage / ProjectCard） */

export const projects = {
  title: '芯片项目',
  subtitle: '每个项目走 6 阶段流程：REQ_SPEC → ARCH → RTL → VERIF → QA → SYNTH',
  newProject: '新建项目',
  emptyState: '暂无项目，点击「新建项目」开始芯片设计流程',
  // 新建 / 导入已有项目表单
  namePlaceholder: '项目名称（如 DDR_BIST_Controller）',
  descriptionPlaceholder: '项目描述（可选）',
  directoryLabel: '项目目录',
  directoryPlaceholder: '留空则使用 MoonGlass 默认目录',
  chooseDirectory: '选择项目目录',
  scanPhases: '扫描已有项目阶段',
  directoryHint: '选择已有工程后会先识别实际阶段；MoonGlass 只补齐缺失的规范目录，不覆盖现有文件。',
  analyzing: '正在扫描项目证据并判断阶段…',
  scanFailed: '目录扫描失败：{error}',
  existingProjectDetected: '识别为已有项目',
  fileCount: '{count} 个文件',
  suggested: '建议：{phase}',
  confidence: '置信度 {value}%',
  noEvidence: '未识别到明确证据',
  initialPhaseLabel: '导入后的当前阶段',
  emptyDirectory: '目录为空，将按全新项目从需求-规格阶段开始。',
  importAndRestore: '导入并恢复阶段',
  importedMessage: '已有项目已导入，恢复到 {phase} · {phaseLabel}；阶段证据报告已写入项目目录。',
  // 编辑项目弹窗
  editTitle: '编辑项目信息',
  nameLabel: '项目名称',
  descriptionLabel: '项目描述',
  editDescriptionPlaceholder: '说明项目目标、主要接口、应用场景和关键约束',
  editHint: '项目目录和开发阶段不会因此改变。',
  // 迁移项目目录
  migrateTitle: '迁移项目目录',
  migrateConfirm: '确认将项目「{name}」迁移到：\n{destination}\n\n迁移完成后原目录会保留，请确认新项目正常后再自行删除。',
  migrating: '正在迁移「{name}」，请勿关闭 MoonGlass…',
  migrated: '「{name}」已迁移，共复制 {count} 个文件；原目录已保留。',
  migrateFailed: '迁移失败：{error}',
  // 项目卡片
  completed: '项目完成',
  defaultDirectory: 'MoonGlass 默认项目目录',
  progress: '进度 {resolved}/{total}（{percent}%）',
  updatedAt: '更新于 {time}',
  deleteTitle: '删除项目',
  deleteConfirm: '确认删除项目「{name}」？'
}

export type ProjectsMessages = typeof projects
