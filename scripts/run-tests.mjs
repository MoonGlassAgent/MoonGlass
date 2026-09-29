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
    'scripts/ut-escalation-smoke.mjs',
    'scripts/config-space-smoke.mjs',
    'scripts/sim-passed-gate-smoke.mjs',
    'scripts/aigv-bug-001-regression-smoke.mjs',
    'scripts/verification-guidance-smoke.mjs',
    'scripts/scenario-hits-smoke.mjs',
    'scripts/verif-batch-verdict-smoke.mjs',
    'scripts/verif-loop-ledger-smoke.mjs',
    'scripts/verif-run-loop-smoke.mjs',
    'scripts/decision-ledger-smoke.mjs',
    'scripts/session-transcript-smoke.mjs',
    'scripts/batch-prompt-smoke.mjs',
    'scripts/formal-smoke.mjs',
    'scripts/waveform-guard-smoke.mjs',
    'scripts/llm-error-smoke.mjs',
    'scripts/eda-install-plan-smoke.mjs',
    'scripts/toolchain-manifest-smoke.mjs',
    'scripts/tb-port-parse-smoke.mjs',
    'scripts/download-mirror-smoke.mjs',
    'scripts/clk-rst-comb-lint-smoke.mjs',
    'scripts/lint-rules-smoke.mjs',
    'scripts/dead-logic-smoke.mjs',
    'scripts/artifact-drift-smoke.mjs'
  ],
  integration: [
    'scripts/design-browser-smoke.mjs',
    'scripts/eda-gate-smoke.mjs',
    'scripts/env-self-check-smoke.mjs',
    'scripts/simulation-artifacts-smoke.mjs',
    'scripts/verilator-coverage-smoke.mjs',
    'scripts/qa-semantic-gate-smoke.mjs',
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
