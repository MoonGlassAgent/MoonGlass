import type { SettingsMessages } from '../zh-CN/settings'

export const settings: SettingsMessages = {
  title: 'Settings',
  more: {
    title: 'More Settings (Placeholder)',
    description: 'Toolchain path configuration (resources/moonglass/toolchains.json) · Company coding rule management · Appearance'
  },
  appearance: {
    title: 'Appearance',
    description: 'Choose light, dark, or system mode, and set the UI accent color. Settings are saved automatically.'
  },
  llm: {
    title: 'Model Service',
    description: 'Configure the API Key / Base URL / model list of each LLM provider (stored locally; chat integration in Phase 2)',
    addCustom: 'Add Custom Provider',
    customProviderName: 'Custom Provider',
    enableProvider: 'Enable this provider',
    protocol: 'Protocol: {name}',
    protocolAnthropic: 'Anthropic Messages',
    protocolOpenai: 'OpenAI Compatible',
    name: 'Name',
    showKey: 'Show',
    hideKey: 'Hide',
    models: 'Models',
    noModels: 'No models yet — add one',
    modelPlaceholder: 'Enter a model ID, press Enter to add',
    removeModel: 'Remove model {model}',
    add: 'Add',
    noKey: 'No API key configured',
    testing: 'Testing…',
    testConnection: 'Test Connection',
    providerConnection: 'Provider Connection',
    httpFoundModels: 'HTTP {status}, found {count} models',
    httpProbedModels: 'HTTP {status}, probed {count} configured models',
    unknownError: 'Unknown connection error',
    thModelId: 'Model ID',
    thStatus: 'Status',
    thNote: 'Details',
    statusUntested: 'Not Tested',
    noModelIds: 'No model IDs configured; the provider connection result is still valid.',
    enabled: 'Enabled',
    disabled: 'Disabled',
    savedEnabled: 'Saved and enabled',
    savedDisabled: 'Saved, but not enabled',
    saveFailed: 'Save failed: {message}',
    testException: 'Test exception: {message}',
    testExceptionModel: 'Test exception; model not tested'
  },
  eda: {
    title: 'Development Environment & EDA Toolchain',
    description: 'Check the runtime, build, verification, synthesis, and timing tools required for the full MoonGlass workflow.',
    detecting: 'Detecting…',
    redetect: 'Re-detect',
    detectingDetail: 'Checking each environment item, version, and executable path…',
    ready: '{ready}/{total} ready',
    emptyGroup: 'No detection items received for this group. Restart MoonGlass so the main process and UI versions stay in sync.',
    noItems: 'The main process returned no environment detection items. Restart MoonGlass and try again.',
    detectFailed: 'Environment detection failed: {message}',
    installStatusFailed: 'Failed to read install status: {message}',
    installStartFailed: 'Failed to start installation: {message}',
    confirmCocotb: 'Install or upgrade Cocotb, cocotb-bus, and cocotb-coverage with pip of the current Python. Continue?',
    confirmOssCad: 'Download OSS CAD Suite from the official GitHub Release. The file is large. Continue?',
    installingCocotb: 'Installing Cocotb via pip…',
    installingBundle: 'Downloading and extracting the bundle — keep the network connected…',
    installing: 'Installing…',
    installCocotb: 'Install Cocotb',
    installBundle: 'Install Bundle',
    installGuide: 'Install Guide',
    openGuideTitle: 'Open the official installation guide',
    builtinError: 'Bundled Component Error',
    builtinErrorDetail: 'This tool should ship with MoonGlass. Reinstall or switch to a complete package.',
    legacyDescription: 'Tool detection item returned by a legacy main process',
    statusReady: 'Ready',
    statusNotFound: 'Not Found',
    importance: {
      required: 'Required',
      recommended: 'Recommended',
      optional: 'Optional'
    },
    source: {
      bundled: 'MoonGlass Bundled',
      managed: 'MoonGlass Managed',
      system: 'System'
    },
    categories: {
      runtime: { label: 'Base Runtime', detail: 'Agent, skill scripts, and dependency management' },
      build: { label: 'Build Environment', detail: 'Version control and local compilation' },
      eda: { label: 'RTL & Synthesis', detail: 'Lint, simulation, and logic synthesis' },
      verification: { label: 'Verification Tools', detail: 'Cocotb, simulators, and waveform viewing' },
      physical: { label: 'Timing & Physical Implementation', detail: 'STA and physical-aware optimization' }
    }
  }
}
