import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { product } from "../sites/product/src/shared/config/product";
import {
    footerLinks,
    mainNavLinks,
    openSource,
    publicSourceLinks,
} from "../sites/product/src/shared/config/navigation";
import {
    repository,
    repositoryBadges,
} from "../sites/product/src/shared/config/repository";
import { site } from "../sites/product/src/shared/config/site";

const readWebsiteFile = (path: string) => readFileSync(path, "utf8");

describe("website user-facing copy", () => {
    test("release pages avoid implementation and storage jargon", () => {
        const releasePage = readWebsiteFile("sites/product/src/pages/releases.astro");
        const docsReleasePage = readWebsiteFile(
            "docs/guides/releases/index.mdx",
        );
        const releaseHistory = readWebsiteFile(
            "sites/product/src/shared/components/ReleaseHistory.tsx",
        );
        const combined = `${releasePage}\n${docsReleasePage}\n${releaseHistory}`;

        for (const phrase of [
            "对象存储",
            "发布数据",
            "远端不可用",
            "本地兜底",
            "index.json",
            "versionIndex",
        ]) {
            expect(combined).not.toContain(phrase);
        }
    });

    test("homepage positioning and features describe a professional user-facing product", () => {
        expect(product.summary).not.toContain(
            "跨平台桌面应用，围绕多数据库支持、AI 原生数据库支持和 AI 智能助手构建统一的数据工作台。",
        );
        expect(product.summary).toContain("专业数据工作台");
        expect(product.features).toHaveLength(6);

        expect(product.features.map((feature) => feature.title)).toEqual([
            "原生驾驭每一种数据形态",
            "让 AI 成为懂数据的副驾",
            "NexusPilot Cloud，跨设备仍由你掌控",
            "每一次变更，都经得起验证",
            "从连接到洞察，一气呵成",
            "安全，从边界开始",
        ]);
    });

    test("homepage download panel keeps release notes behind a deliberate link", () => {
        const downloadPanel = readWebsiteFile(
            "sites/product/src/components/DownloadPanel.tsx",
        );

        expect(downloadPanel).not.toContain("latestVersion.sections");
        expect(downloadPanel).not.toContain("highlights");
        expect(downloadPanel).not.toContain("sections.flatMap");
        expect(downloadPanel).toContain("查看发布日志");
    });

    test("release history does not repeat version summaries above the notes", () => {
        const releaseHistory = readWebsiteFile(
            "sites/product/src/shared/components/ReleaseHistory.tsx",
        );

        expect(releaseHistory).not.toContain("version.summary");
    });

    test("homepage download hint is visually subdued", () => {
        const downloadPanel = readWebsiteFile(
            "sites/product/src/components/DownloadPanel.tsx",
        );

        expect(downloadPanel).toContain("download-panel-hint");
        expect(downloadPanel).toContain("text-xs");
        expect(downloadPanel).toContain("text-zinc-500");
        expect(downloadPanel).not.toContain("mt-3 text-sm leading-6 text-zinc-300");
    });

    test("public open-source entry points use the formal NexusPilot repository", () => {
        const openSourcePage = readWebsiteFile(
            "docs/guides/project/open-source-plan.md",
        );
        const contributingPage = readWebsiteFile(
            "docs/guides/project/contributing.md",
        );
        const combined = `${openSourcePage}\n${contributingPage}`;

        expect(openSource.status).toBe("public");
        expect(openSource.repositoryHref).toBe(
            repository.url,
        );
        expect(openSource.issuesHref).toBe(
            repository.issuesUrl,
        );
        expect(publicSourceLinks.map((link) => link.label)).toEqual([
            "GitHub",
            "Issues",
            "参与贡献",
            "Apache-2.0",
            "安全报告",
        ]);
        expect(repositoryBadges.stars.src).toContain(
            "https://img.shields.io/github/stars/GuqierMcl/NexusPilot",
        );
        expect(repositoryBadges.forks.src).toContain(
            "https://img.shields.io/github/forks/GuqierMcl/NexusPilot",
        );
        expect(repositoryBadges.license.src).toContain(
            "https://img.shields.io/github/license/GuqierMcl/NexusPilot",
        );
        expect(combined).not.toContain("当前仓库尚未开放");
        expect(combined).not.toContain("项目开放后");
    });

    test("all product-site documentation entry points use docs.nexuspilot.dev", () => {
        const heroSource = readWebsiteFile(
            "sites/product/src/components/Hero.astro",
        );
        const notFoundSource = readWebsiteFile(
            "sites/product/src/pages/404.astro",
        );

        expect(site.docsUrl).toBe("https://docs.nexuspilot.dev");
        expect(mainNavLinks.find((link) => link.label === "文档")?.href).toBe(
            site.docsUrl,
        );
        expect(footerLinks.find((link) => link.label === "文档")?.href).toBe(
            site.docsUrl,
        );
        expect(heroSource).toContain("href={site.docsUrl}");
        expect(notFoundSource).toContain("href={site.docsUrl}");
    });
});
