import { describe, expect, test } from "bun:test";

import {
  createLatestJson,
  createReleaseManifest,
  createSha256Manifest,
  normalizePublicUrl,
} from "./manifest.mjs";

describe("release manifest helpers", () => {
  test("normalizes public URLs without duplicate slashes", () => {
    expect(normalizePublicUrl("https://dl.nexuspilot.dev/oss/releases/", "v0.3.2/windows/file.exe")).toBe(
      "https://dl.nexuspilot.dev/oss/releases/v0.3.2/windows/file.exe",
    );
  });

  test("creates Tauri updater latest.json for the configured updater artifact", () => {
    const latest = createLatestJson({
      version: "0.3.2",
      notes: "v0.3.2 更新内容：",
      pubDate: "2026-07-02T00:00:00Z",
      publicBaseUrl: "https://dl.nexuspilot.dev/oss/releases",
      platform: "windows-x86_64",
      artifactRelativePath: "v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
      signature: "trusted signature",
    });

    expect(latest).toEqual({
      version: "0.3.2",
      notes: "v0.3.2 更新内容：",
      pub_date: "2026-07-02T00:00:00Z",
      platforms: {
        "windows-x86_64": {
          signature: "trusted signature",
          url: "https://dl.nexuspilot.dev/oss/releases/v0.3.2/windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
        },
      },
    });
  });

  test("creates an internal release manifest and checksum manifest", () => {
    const release = createReleaseManifest({
      version: "0.3.2",
      tag: "v0.3.2",
      generatedAt: "2026-07-02T00:00:00Z",
      artifacts: [
        {
          relativePath: "windows-x86_64/NexusPilot_0.3.2_x64-setup.exe",
          sha256: "abc123",
          size: 42,
          platform: "windows-x86_64",
          bundle: "nsis",
          role: "installer",
        },
      ],
    });

    expect(release.artifacts[0].relativePath).toBe("windows-x86_64/NexusPilot_0.3.2_x64-setup.exe");
    expect(createSha256Manifest(release.artifacts)).toBe(
      "abc123  windows-x86_64/NexusPilot_0.3.2_x64-setup.exe\n",
    );
  });
});
