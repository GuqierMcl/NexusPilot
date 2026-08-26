import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
    repository,
    repositoryBadges,
} from "../sites/product/src/shared/config/repository";

const readWebsiteFile = (path: string) => readFileSync(path, "utf8");

describe("website open-source presentation", () => {
    test("keeps repository metadata and Shields badges in one shared config", () => {
        expect(repository.url).toBe(
            "https://github.com/GuqierMcl/NexusPilot",
        );
        expect(repository.license).toBe("Apache-2.0");

        for (const badge of Object.values(repositoryBadges)) {
            const badgeUrl = new URL(badge.src);

            expect(badgeUrl.origin).toBe("https://img.shields.io");
            expect(badgeUrl.searchParams.get("style")).toBe("flat");
            expect(badgeUrl.searchParams.get("labelColor")).toBe("18181b");
            expect(badge.href.startsWith("https://github.com/")).toBe(true);
        }
    });

    test("renders repository discovery across the header, hero, and homepage", () => {
        const headerSource = readWebsiteFile(
            "sites/product/src/components/Header.astro",
        );
        const heroSource = readWebsiteFile(
            "sites/product/src/components/Hero.astro",
        );
        const homepageSource = readWebsiteFile(
            "sites/product/src/pages/index.astro",
        );
        const openSourceSource = readWebsiteFile(
            "sites/product/src/components/OpenSource.astro",
        );

        expect(headerSource).toContain("repositoryBadges.stars");
        expect(headerSource).toContain('loading="eager"');
        expect(heroSource).toContain("Desktop 与本地 AI Runtime 已采用 Apache-2.0 开源");
        expect(homepageSource).toContain("<OpenSource />");
        expect(openSourceSource).toContain('id="open-source"');
        expect(openSourceSource).toContain("repositoryBadges.forks");
        expect(openSourceSource).toContain("repositoryBadges.license");
        expect(openSourceSource).toContain("repositoryBadges.lastCommit");
        expect(openSourceSource).toContain("查看 GitHub 仓库");
        expect(openSourceSource).toContain("参与贡献");
    });

    test("uses static Shields images without adding a GitHub API client", () => {
        const badgeSource = readWebsiteFile(
            "sites/product/src/components/ShieldBadge.astro",
        );
        const repositorySource = readWebsiteFile(
            "sites/product/src/shared/config/repository.ts",
        );

        expect(badgeSource).toContain('referrerpolicy="no-referrer"');
        expect(badgeSource).toContain('decoding="async"');
        expect(repositorySource).not.toContain("api.github.com");
        expect(repositorySource).not.toContain("fetch(");
    });

    test("publishes repository and license metadata for search engines", () => {
        const layoutSource = readWebsiteFile(
            "sites/product/src/layouts/BaseLayout.astro",
        );

        expect(layoutSource).toContain('"@type": "SoftwareApplication"');
        expect(layoutSource).toContain("codeRepository: repository.url");
        expect(layoutSource).toContain("license: repository.licenseUrl");
        expect(layoutSource).toContain('href="https://img.shields.io"');
    });
});
