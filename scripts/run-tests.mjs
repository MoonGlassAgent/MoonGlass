import { spawnSync } from 'node:child_process'

const suites = {
  core: [
    'scripts/rtl-engine-smoke.mjs',
    'scripts/agent-interaction-smoke.mjs',
    'scripts/agent-event-routing-smoke.mjs',
    'scripts/agent-run-watchdog-smoke.mjs',
    'scripts/sram-generator-smoke.mjs',
    'scripts/doc-repository-validator-smoke.mjs',
    'scripts/file-reference-smoke.mjs',
    'scripts/project-import-analyzer-smoke.mjs',
    'scripts/pi-rpc-event-smoke.mjs',
    'scripts/pi-tools-smoke.mjs',
    'scripts/verification-intelligence-smoke.mjs',
    'scripts/aigv-bug-001-regression-smoke.mjs',
    'scripts/verification-guidance-smoke.mjs',
    'scripts/scenario-hits-smoke.mjs',
    'scripts/verif-batch-verdict-smoke.mjs',
    'scripts/session-transcript-smoke.mjs',
    'scripts/batch-prompt-smoke.mjs',
    'scripts/formal-smoke.mjs',
    'scripts/waveform-guard-smoke.mjs',
    'scripts/llm-error-smoke.mjs',
    'scripts/eda-install-plan-smoke.mjs'
  ],
  integration: [
    'scripts/design-browser-smoke.mjs',
    'scripts/eda-gate-smoke.mjs',
    'scripts/simulation-artifacts-smoke.mjs',
    'scripts/verilator-coverage-smoke.mjs',
    'scripts/synthesis-flow-smoke.mjs'
  ]
}

const suiteName = process.argv[2] ?? 'core'
const scripts = suites[suiteName]
if (!scripts) {
  console.error(`未知测试套件: ${suiteName}`)
  process.exit(2)
}

for (const script of scripts) {
  console.log(`\n[test] ${script}`)
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log(`\n[test] ${suiteName} suite passed (${scripts.length} scripts)`)
