export const site = {
  name: "NexusPilot",
  docsTitle: "NexusPilot Docs",
  description:
    "NexusPilot 文档：安装、快速开始、数据库连接、工作台概念与 AI 助手使用指南。",
  url: "https://docs.nexuspilot.dev",
  productUrl: "https://nexuspilot.dev",
  defaultLocale: "zh-CN",
} as const;

export type SiteConfig = typeof site;
