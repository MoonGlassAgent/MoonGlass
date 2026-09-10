import type { InformationMessages } from '../zh-CN/information'

export const information: InformationMessages = {
  versionTagline: 'Version {version} · AI Workbench for the Full Chip Development Flow',
  license: {
    title: 'License',
    sourceAvailableDesc: 'The MoonGlass source code is publicly available, but it is not Open Source software as defined by the OSI. It is free for personal study, experimentation, non-commercial education, and non-commercial organizational use covered by the license.',
    viewLicense: 'View {name}',
    commercialTitle: 'Written Authorization Required for Commercial Use',
    commercialDesc: 'Commercial R&D within enterprises, customer deliverables, paid services, tape-out, mass production, and other intended commercial applications require a separate written commercial license before use. Published prices are for reference only; the formal contract defines the scope of authorization.',
    ownershipNote: 'Specifications, RTL, verification assets, and design outputs lawfully provided by users remain the property of the users or their rights holders; embedded MoonGlass code, templates, and third-party components remain governed by their respective licenses.'
  },
  manual: {
    title: 'Quick Start Guide',
    tip: 'On first use, configure the model service and check the EDA toolchain in Settings, then create a project and assign a project directory. The main session drives progress, while parallel sessions can pick their own models for reviews. Project files, waveforms, and the RTL Design Browser are all accessed from the workspace.'
  },
  flow: {
    step1: { title: 'Requirement & Spec Definition', description: 'Use the Agent to organize requirements, specifications, and the requirement-spec traceability matrix.' },
    step2: { title: 'Architecture Design', description: 'Produce module partitioning, interfaces, clock/reset, registers, and microarchitecture design.' },
    step3: { title: 'RTL Development', description: 'Generate and review RTL; run Lint, CDC, and synthesizability checks.' },
    step4: { title: 'Verification Completeness', description: 'Organize risk scenarios, timing, and boundary interactions with Verification Intent; run Simulation/Formal/Static, classify coverage holes, and complete independent evidence reviews.' },
    step5: { title: 'Quality Checks', description: 'Run checklists, cross reviews, change reviews, and release gates.' },
    step6: { title: 'Synthesis & Implementation', description: 'Invoke synthesis and STA tools to evaluate area, timing, and implementation risks.' }
  },
  support: {
    title: 'Author & Support',
    description: 'For licensing inquiries, custom development, security issues, and product suggestions, contact us by email. Do not send API keys, customer secrets, or restricted chip design data.',
    copyEmail: 'Copy email',
    privacyNote: 'Privacy note: projects and sessions are stored locally by default; when calling external LLMs, the selected context may be sent to the corresponding provider. Third-party models, EDA tools, IPs, and PDKs are subject to their own terms.',
    qrAlt: 'WeChat QR code for commercial licensing inquiries',
    qrCaption: 'WeChat for commercial licensing inquiries'
  }
}
