export const site = {
  name: "NexusPilot",
  docsTitle: "NexusPilot Docs",
  title: "NexusPilot - AI Native 数据库管理平台",
  description:
    "NexusPilot 是 AI Native 数据库管理平台，面向多数据库支持、AI 原生数据库支持和 AI 智能助手工作流。",
  url: "https://nexuspilot.dev",
  defaultLocale: "zh-CN",
  futureLocales: ["en"],
  ogImage: "/logo.svg",
} as const;

export type SiteConfig = typeof site;
