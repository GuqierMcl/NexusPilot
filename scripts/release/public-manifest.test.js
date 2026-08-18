import { describe, expect, test } from "bun:test";

import { extractVersionSection } from "./changelog.mjs";
import {
  createPublicReleaseIndex,
  createPublicReleaseVersion,
} from "./public-manifest.mjs";

const changelog = `# Changelog

## [0.3.2] - 2026-07-02

### Feature

- 新增 Windows 安装器语言选择。

### Optimization

- 优化更新弹窗。

### Fixed

- 修复更新日志过长时撑开弹窗的问题。
`;

const artifacts = [
  {
    relativePath: "windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
    sha256: "setup-sha",
    size: 37736105,
    platform: "windows-x86_64",
    bundle: "nsis",
    role: "installer",
  },
  {
    relativePath: "windows-x86_64/NexusPilot_0.3.2_x64-setup.exe.sig",
    sha256: "sig-sha",
    size: 128,
    platform: "windows-x86_64",
    bundle: "nsis",
    role: "signature",
  },
  {
    relativePath: "windows-x86_64/NexusPilot_0.3.2_x64_en-US.msi",
    sha256: "msi-sha",
    size: 41111111,
    platform: "windows-x86_64",
    bundle: "msi",
    role: "installer",
  },
];

describe("public release index", () => {
  test("creates one website/docs index with downloads and notesUrl", () => {
    const publicVersion = createPublicReleaseVersion({
      versionSection: extractVersionSection(changelog, "0.3.2"),
      tag: "v0.3.2",
      publicBaseUrl: "https://dl.nexuspilot.dev/releases",
      artifacts,
      updaterPlatform: "windows-x86_64",
      updaterBundle: "nsis",
    });
    const index = createPublicReleaseIndex({
      generatedAt: "2026-07-05T12:00:00Z",
      versions: [publicVersion],
    });

    expect(index).toMatchObject({
      schemaVersion: 1,
      product: "NexusPilot",
      channel: "stable",
      latest: {
        version: "0.3.2",
        tag: "v0.3.2",
      },
    });
    expect(index.versions[0].summary).toBe("新增 Windows 安装器语言选择。");
    expect(index.versions[0].notesUrl).toBe(
      "https://dl.nexuspilot.dev/releases/v0.3.2/notes.md",
    );
    expect(index.versions[0].recommendedDownloadUrl).toBe(
      "https://dl.nexuspilot.dev/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
    );
    expect(index.versions[0].downloads).toEqual([
      {
        platform: "windows-x86_64",
        bundle: "nsis",
        label: "Windows 安装包",
        url: "https://dl.nexuspilot.dev/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
        signatureUrl: "https://dl.nexuspilot.dev/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe.sig",
        sha256: "setup-sha",
        size: 37736105,
        recommended: true,
      },
      {
        platform: "windows-x86_64",
        bundle: "msi",
        label: "Windows MSI 安装包",
        url: "https://dl.nexuspilot.dev/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64_en-US.msi",
        sha256: "msi-sha",
        size: 41111111,
        recommended: false,
      },
    ]);
    expect(index.versions[0].links).toEqual({
      checksums: "https://dl.nexuspilot.dev/releases/v0.3.2/checksums.sha256",
      versionIndex: "https://dl.nexuspilot.dev/releases/v0.3.2/index.json",
      versionUpdaterManifest: "https://dl.nexuspilot.dev/releases/v0.3.2/latest.json",
    });
  });

  test("creates historical entries without broken download links", () => {
    const historicalVersion = createPublicReleaseVersion({
      versionSection: extractVersionSection(changelog, "0.3.2"),
      publicBaseUrl: "https://dl.nexuspilot.dev/releases",
    });

    expect(historicalVersion.notesUrl).toBe(
      "https://dl.nexuspilot.dev/releases/v0.3.2/notes.md",
    );
    expect(historicalVersion.recommendedDownloadUrl).toBeUndefined();
    expect(historicalVersion.downloads).toEqual([]);
    expect(historicalVersion.sections[0].title).toBe("新功能");
  });
});
