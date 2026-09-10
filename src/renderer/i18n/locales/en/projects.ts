import type { ProjectsMessages } from '../zh-CN/projects'

export const projects: ProjectsMessages = {
  title: 'Chip Projects',
  subtitle: 'Each project follows the 6-phase flow: REQ_SPEC → ARCH → RTL → VERIF → QA → SYNTH',
  newProject: 'New Project',
  emptyState: 'No projects yet. Click "New Project" to start the chip design flow',
  // 新建 / 导入已有项目表单
  namePlaceholder: 'Project name (e.g. DDR_BIST_Controller)',
  descriptionPlaceholder: 'Project description (optional)',
  directoryLabel: 'Project Directory',
  directoryPlaceholder: 'Leave empty to use the MoonGlass default directory',
  chooseDirectory: 'Choose project directory',
  scanPhases: 'Scan existing project phases',
  directoryHint: 'An existing workspace is analyzed first to detect its actual phase. MoonGlass only adds missing spec directories and never overwrites existing files.',
  analyzing: 'Scanning project evidence and determining phase…',
  scanFailed: 'Directory scan failed: {error}',
  existingProjectDetected: 'Existing project detected',
  fileCount: '{count} files',
  suggested: 'Suggested: {phase}',
  confidence: 'Confidence {value}%',
  noEvidence: 'No clear evidence detected',
  initialPhaseLabel: 'Current phase after import',
  emptyDirectory: 'The directory is empty. A new project will start from the REQ_SPEC phase.',
  importAndRestore: 'Import & Restore Phase',
  importedMessage: 'Existing project imported and restored to {phase} · {phaseLabel}. The phase evidence report has been written to the project directory.',
  // 编辑项目弹窗
  editTitle: 'Edit Project Info',
  nameLabel: 'Project Name',
  descriptionLabel: 'Project Description',
  editDescriptionPlaceholder: 'Describe the project goals, main interfaces, application scenarios, and key constraints',
  editHint: 'The project directory and development phase will not change.',
  // 迁移项目目录
  migrateTitle: 'Migrate project directory',
  migrateConfirm: 'Migrate project "{name}" to:\n{destination}\n\nThe original directory will be kept after migration. Please verify the new project before deleting it yourself.',
  migrating: 'Migrating "{name}". Do not close MoonGlass…',
  migrated: '"{name}" migrated. {count} files copied. The original directory has been kept.',
  migrateFailed: 'Migration failed: {error}',
  // 项目卡片
  completed: 'Project Completed',
  defaultDirectory: 'MoonGlass default project directory',
  progress: 'Progress {resolved}/{total} ({percent}%)',
  updatedAt: 'Updated {time}',
  deleteTitle: 'Delete project',
  deleteConfirm: 'Delete project "{name}"?'
}
