import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { resolve } from 'node:path'

const { readRtlInputs } = await import('../packages/eda-bridge/src/rtl-files.ts')
const { runDesignLint } = await import('../packages/eda-bridge/src/lint.ts')

const workspace = resolve(process.argv[2] ?? process.cwd())
const inputs = readRtlInputs(workspace)
if (inputs.designFiles.length === 0) {
  console.error(`未找到设计 RTL：${workspace}`)
  process.exit(2)
}

const result = await runDesignLint({
  files: inputs.designFiles,
  libraryFiles: inputs.libraryFiles,
  topModule: inputs.topModule,
  includeDirs: inputs.includeDirs,
  defines: inputs.defines
})

console.log(JSON.stringify({
  workspace,
  topModule: inputs.topModule ?? null,
  designFiles: inputs.designFiles.length,
  libraryFiles: inputs.libraryFiles.length,
  passed: result.passed,
  errors: result.errors,
  warnings: result.warnings
}, null, 2))
process.exit(result.passed ? 0 : 1)
