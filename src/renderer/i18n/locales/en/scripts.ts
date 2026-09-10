import type { ScriptsMessages } from '../zh-CN/scripts'

export const scripts: ScriptsMessages = {
  title: 'Python Scripts',
  subtitle: 'Script template library placeholder (upgraded to Notebook Cell interaction + per-project venv in Phase 2)',
  templates: {
    rtlBatch: { name: 'RTL Batch Generation', description: 'Generate RTL modules in batch from parameterized configurations' },
    regTable: { name: 'Register Table Generation', description: 'Generate register RTL and documentation from specification tables' },
    waveAnalysis: { name: 'Waveform Analysis', description: 'Parse VCD waveforms and count signal toggles' },
    coverageParse: { name: 'Coverage Parsing', description: 'Parse coverage reports into summaries' },
    sdcGen: { name: 'SDC Generation', description: 'Generate SDC constraint files from clock specifications' }
  },
  quickRun: {
    title: 'Quick Run (Smoke Test)',
    run: '▶ Run',
    running: 'Running…'
  }
}
