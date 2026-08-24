export interface NavLink {
  label: string;
  href: string;
}

export interface OpenSourceConfig {
  status: "planned" | "public";
  planHref: string;
  repositoryHref?: string;
  issuesHref?: string;
}

export const mainNavLinks: NavLink[] = [
  { label: "首页", href: "/" },
  { label: "特性", href: "/#features" },
  { label: "数据库", href: "/#databases" },
  { label: "文档", href: site.docsUrl },
  { label: "下载", href: "/#download" },
  { label: "发布日志", href: "/releases" },
];

export const footerLinks: NavLink[] = [
  { label: "文档", href: site.docsUrl },
  { label: "发布日志", href: "/releases" },
  { label: "支持数据库", href: "/#databases" },
  { label: "开源项目", href: `${site.docsUrl}/project/open-source-plan/` },
  { label: "联系我们", href: `${site.docsUrl}/project/contact/` },
];

export const openSource: OpenSourceConfig = {
  status: "public",
  planHref: `${site.docsUrl}/project/open-source-plan/`,
  repositoryHref: "https://github.com/GuqierMcl/NexusPilot",
  issuesHref: "https://github.com/GuqierMcl/NexusPilot/issues",
};

export const publicSourceLinks: NavLink[] =
  openSource.status === "public" && openSource.repositoryHref
    ? [
        { label: "GitHub", href: openSource.repositoryHref },
        ...(openSource.issuesHref
          ? [{ label: "Issues", href: openSource.issuesHref }]
          : []),
      ]
    : [];
import { site } from "./site";
