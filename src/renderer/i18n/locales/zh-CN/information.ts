/** 关于页文案（授权信息、快速使用手册、作者与支持） */

export const information = {
  versionTagline: '版本 {version} · 芯片开发全流程 AI 工作台',
  license: {
    title: '授权信息',
    sourceAvailableDesc: 'MoonGlass 源代码公开，但不是 OSI 定义的 Open Source 软件。个人学习、实验、非商业教育和许可证涵盖的非商业组织用途可免费使用。',
    viewLicense: '查看 {name}',
    commercialTitle: '商用须书面授权',
    commercialDesc: '企业内部商业研发、客户交付、收费服务、流片、量产及其他预期商业应用，使用前须取得单独的书面商用许可。公开价格仅供参考，正式合同确定授权边界。',
    ownershipNote: '用户合法输入的规格、RTL、验证资产与设计输出归用户或其权利人所有；嵌入的 MoonGlass 代码、模板及第三方组件仍受各自许可证约束。'
  },
  manual: {
    title: '快速使用手册',
    tip: '首次使用先在“设置”中配置模型服务并检测 EDA 工具链，再新建项目并指定项目目录。主会话负责推进，平行会话可独立选择模型进行 Review；项目文件、波形和 RTL Design Browser 均从工作区进入。'
  },
  flow: {
    step1: { title: '需求-规格定义', description: '通过 Agent 梳理需求、规格和需求-规格追踪矩阵。' },
    step2: { title: '架构设计', description: '形成模块划分、接口、时钟复位、寄存器和微架构设计。' },
    step3: { title: 'RTL 开发', description: '生成并评审 RTL，运行 Lint、CDC 与可综合性检查。' },
    step4: { title: '验证完备', description: '以 Verification Intent 组织风险场景、时间与边界交互，执行 Simulation/Formal/Static，分类 Coverage Hole 并完成独立证据审查。' },
    step5: { title: '质量检查', description: '执行清单、交叉 Review、变更审查与发布门禁。' },
    step6: { title: '综合实现', description: '调用综合与 STA 工具，评估面积、时序和实现风险。' }
  },
  support: {
    title: '作者与支持',
    description: '授权咨询、定制开发、安全问题和产品建议可通过邮件联系。请勿发送 API Key、客户机密或受限制芯片设计数据。',
    copyEmail: '复制邮箱',
    privacyNote: '隐私提示：项目与会话默认保存在本机；调用外部 LLM 时，所选上下文可能发送至对应服务商。第三方模型、EDA 工具、IP 和 PDK 适用其各自条款。',
    qrAlt: '微信商务授权咨询二维码',
    qrCaption: '微信商务授权咨询'
  }
}

export type InformationMessages = typeof information
