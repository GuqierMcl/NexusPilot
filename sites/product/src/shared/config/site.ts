export const site = {
  name: "NexusPilot",
  title: "NexusPilot - AI Native 多数据库工作台",
  description:
    "NexusPilot 是面向开发者和数据团队的 AI Native 多数据库桌面工作台，支持自然语言数据探索、引擎原生对象管理和经过审批的智能体工具执行。",
  url: "https://nexuspilot.dev",
  docsUrl: "https://docs.nexuspilot.dev",
  defaultLocale: "zh-CN",
  futureLocales: ["en"],
  ogImage: "/logo.svg",
} as const;

export type SiteConfig = typeof site;
