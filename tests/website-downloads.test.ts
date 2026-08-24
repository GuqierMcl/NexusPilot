import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { formatBundleLabel } from "../sites/product/src/shared/release-registry/format";
import {
    resolveReleaseDownloads,
    sortReleaseDownloads,
} from "../sites/product/src/shared/release-registry/downloads";
import type {
    PublicReleaseDownload,
    PublicReleaseIndex,
    PublicReleaseVersion,
} from "../sites/product/src/shared/release-registry/types";

const readWebsiteFile = (path: string) => readFileSync(path, "utf8");

const exeDownload: PublicReleaseDownload = {
    platform: "windows-x86_64",
    bundle: "nsis",
    label: "Windows 安装包",
    url: "https://downloads.example.test/nexuspilot.exe",
    signatureUrl: "https://downloads.example.test/nexuspilot.exe.sig",
    sha256: "exe-sha",
    size: 42_000_000,
    recommended: true,
};

const msiDownload: PublicReleaseDownload = {
    platform: "windows-x86_64",
    bundle: "msi",
    label: "Windows MSI 安装包",
    url: "https://downloads.example.test/nexuspilot.msi",
    signatureUrl: "https://downloads.example.test/nexuspilot.msi.sig",
    sha256: "msi-sha",
    size: 56_000_000,
    recommended: false,
};

const versionWithoutDownloads: PublicReleaseVersion = {
    version: "0.4.1",
    tag: "v0.4.1",
    pubDate: "2026-07-05T00:00:00Z",
    summary: "SQL 编辑器结果栏新增折叠按钮。",
    sections: [],
    downloads: [],
    links: {
        versionIndex: "https://downloads.example.test/releases/v0.4.1/index.json",
    },
};

describe("website downloads", () => {
    test("uses explicit artifact labels for Windows installers", () => {
        expect(formatBundleLabel("nsis")).toBe("EXE");
        expect(formatBundleLabel("msi")).toBe("MSI");
    });

    test("sorts recommended downloads first while keeping other artifacts available", () => {
        const sorted = sortReleaseDownloads([msiDownload, exeDownload]);

        expect(sorted.map((download) => download.bundle)).toEqual(["nsis", "msi"]);
    });

    test("hydrates old release downloads from the version release index", async () => {
        const versionIndex: PublicReleaseIndex = {
            schemaVersion: 1,
            product: "NexusPilot",
            channel: "stable",
            generatedAt: "2026-07-05T12:55:03.494Z",
            latest: {
                version: "0.4.1",
                tag: "v0.4.1",
            },
            versions: [
                {
                    ...versionWithoutDownloads,
                    downloads: [msiDownload, exeDownload],
                },
            ],
        };

        const downloads = await resolveReleaseDownloads(
            versionWithoutDownloads,
            async () => versionIndex,
        );

        expect(downloads.map((download) => download.bundle)).toEqual(["nsis", "msi"]);
        expect(downloads[0]?.url).toBe(exeDownload.url);
    });

    test("does not refetch a version index when release downloads are already present", async () => {
        let fetchCount = 0;
        const downloads = await resolveReleaseDownloads(
            { ...versionWithoutDownloads, downloads: [exeDownload] },
            async () => {
                fetchCount += 1;
                throw new Error("should not be called");
            },
        );

        expect(fetchCount).toBe(0);
        expect(downloads).toEqual([exeDownload]);
    });

    test("homepage download panel is not tied to Windows-only copy or a single artifact", () => {
        const downloadPanel = readWebsiteFile(
            "sites/product/src/components/DownloadPanel.tsx",
        );

        expect(downloadPanel).not.toContain("下载最新 Windows 安装包");
        expect(downloadPanel).not.toContain("下载 Windows 版本");
        expect(downloadPanel).toContain("downloadOptions.map");
        expect(downloadPanel).toContain("formatPlatformLabel(download.platform)");
        expect(downloadPanel).toContain("formatBundleLabel(download.bundle)");
    });
});
