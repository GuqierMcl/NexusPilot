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

    test("homepage positioning leads with concrete AI-native capabilities", () => {
        expect(product.summary).toContain("AI Native 多数据库工作台");
        expect(product.summary).toContain("自然语言");
        expect(product.summary).toContain("引擎原生对象");
        expect(product.summary).toContain("受控工具");
        expect(product.features).toHaveLength(8);

        expect(product.features.map((feature) => feature.title)).toEqual([
            "自然语言数据智能体",
            "受控的智能体工具执行",
            "多数据源连接与对象探索",
            "面向引擎的查询与操作工作区",
            "数据内容查看与安全变更",
            "引擎原生对象管理",
            "自选模型与本地 AI Runtime",
            "端到端加密的跨设备同步",
        ]);

        const featureTitles = product.features.map((feature) => feature.title).join("\n");
        expect(featureTitles).not.toMatch(/SQL|表格|表结构/);
        expect(product.features[0]?.description).toContain("Ask、Query 和 Agent");
        expect(product.features[1]?.description).toContain("驱动能力");
    });

    test("website and bilingual READMEs share the engine-neutral capability model", () => {
        const featuresSource = readWebsiteFile(
            "sites/product/src/components/Features.astro",
        );
        const chineseReadme = readWebsiteFile("README.zh-CN.md");
        const englishReadme = readWebsiteFile("README.md");

        expect(featuresSource).toContain("核心功能");
        expect(chineseReadme).toContain("## ✨ 核心功能");
        expect(englishReadme).toContain("## ✨ Core Capabilities");

        for (const feature of product.features) {
            expect(chineseReadme).toContain(`**${feature.title}**`);
        }

        for (const title of [
            "Natural-language data agent",
            "Controlled agent tool execution",
            "Multi-source connections and object exploration",
            "Engine-aware query and operation workspaces",
            "Data inspection and safe mutations",
            "Engine-native object management",
            "Bring-your-own models with a local AI Runtime",
            "End-to-end encrypted device sync",
        ]) {
            expect(englishReadme).toContain(`**${title}**`);
        }

        expect(`${chineseReadme}\n${englishReadme}`).not.toContain("RAG 检索测试");
    });

    test("README database matrices expose data models and AI tool integration", () => {
        const chineseReadme = readWebsiteFile("README.zh-CN.md");
        const englishReadme = readWebsiteFile("README.md");
        const englishDataModels: Record<string, string> = {
            MySQL: "Relational",
            PostgreSQL: "Relational",
            Redis: "Key-value",
            Oracle: "Relational",
            SQLite: "Relational",
            ClickHouse: "Columnar analytics",
        };

        expect(chineseReadme).toContain(
            "| 数据库 | 数据形态 | AI 工具接入 | 状态 |",
        );
        expect(englishReadme).toContain(
            "| Database | Data model | AI tool integration | Status |",
        );

        for (const database of product.databases.filter(
            (item) => item.status === "available",
        )) {
            expect(chineseReadme).toContain(
                `| **${database.name}** | ${database.type} | ✅ 已接入 | ✅ 支持 |`,
            );
            expect(englishReadme).toContain(
                `| **${database.name}** | ${englishDataModels[database.name]} | ✅ Integrated | ✅ Supported |`,
            );
        }

        expect(chineseReadme).toContain("不表示所有读写和管理操作均已开放");
        expect(englishReadme).toContain(
            "not that every read, write, or management operation is enabled",
        );
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
