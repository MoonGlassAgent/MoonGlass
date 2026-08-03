import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve('resources/moonglass/skills')
if (!existsSync(root)) throw new Error(`MoonGlass Skills 目录不存在: ${root}`)

const skillDirs = readdirSync(root)
  .map(name => join(root, name))
  .filter(path => statSync(path).isDirectory())

if (skillDirs.length === 0) throw new Error('MoonGlass 至少需要一个内置 Skill')

const failures = []
for (const dir of skillDirs) {
  const skillFile = join(dir, 'SKILL.md')
  if (!existsSync(skillFile)) {
    failures.push(`${relative(root, dir)}: 缺少 SKILL.md`)
    continue
  }

  const content = readFileSync(skillFile, 'utf8')
  if (!content.trim()) failures.push(`${relative(root, skillFile)}: 文件为空`)
  if (!/^---\s*$/m.test(content)) failures.push(`${relative(root, skillFile)}: 缺少 YAML frontmatter`)
  if (!/^name:\s*\S+/m.test(content)) failures.push(`${relative(root, skillFile)}: 缺少 name`)
  if (!/^description:\s*\S+/m.test(content)) failures.push(`${relative(root, skillFile)}: 缺少 description`)
}

if (failures.length > 0) {
  console.error(failures.map(item => `- ${item}`).join('\n'))
  process.exit(1)
}

console.log(`Skills check passed: ${skillDirs.length} built-in skills from ${root}`)
