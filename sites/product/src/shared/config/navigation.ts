import { repository } from "./repository";
import { site } from "./site";

export interface NavLink {
  label: string;
  href: string;
}

export interface OpenSourceConfig {
  status: "planned" | "public";
  planHref: string;
  repositoryHref?: string;
  issuesHref?: string;
  contributingHref?: string;
  licenseHref?: string;
  securityHref?: string;
}

export const mainNavLinks: NavLink[] = [
  { label: "首页", href: "/" },
  { label: "特性", href: "/#features" },
  { label: "开源", href: "/#open-source" },
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
  repositoryHref: repository.url,
  issuesHref: repository.issuesUrl,
  contributingHref: `${site.docsUrl}/project/contributing/`,
  licenseHref: repository.licenseUrl,
  securityHref: repository.securityUrl,
};

export const publicSourceLinks: NavLink[] =
  openSource.status === "public" && openSource.repositoryHref
    ? [
        { label: "GitHub", href: openSource.repositoryHref },
        ...(openSource.issuesHref
          ? [{ label: "Issues", href: openSource.issuesHref }]
          : []),
        ...(openSource.contributingHref
          ? [{ label: "参与贡献", href: openSource.contributingHref }]
          : []),
        ...(openSource.licenseHref
          ? [{ label: "Apache-2.0", href: openSource.licenseHref }]
          : []),
        ...(openSource.securityHref
          ? [{ label: "安全报告", href: openSource.securityHref }]
          : []),
      ]
    : [];
