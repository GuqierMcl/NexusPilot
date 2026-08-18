import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  classifyTauriArtifact,
  createReleaseLayout,
  resolveReleaseVersionDir,
} from "./artifacts.mjs";

describe("release artifact helpers", () => {
  test("creates a versioned release layout with cross-platform slots", () => {
    const layout = createReleaseLayout("D:/repo", "releases", "0.3.2");

    expect(layout.version).toBe("0.3.2");
    expect(layout.tag).toBe("v0.3.2");
    expect(layout.rootDir).toBe(path.join("D:/repo", "releases", "v0.3.2"));
    expect(layout.registryRootDir).toBe(path.join("D:/repo", "releases"));
    expect(layout.platformDirs.windows).toBe(path.join(layout.rootDir, "windows-x86_64"));
    expect(layout.logsDir).toBe(path.join(layout.rootDir, "logs"));
    expect(layout.indexJsonPath).toBe(path.join(layout.rootDir, "index.json"));
    expect(layout.latestJsonPath).toBe(path.join(layout.rootDir, "latest.json"));
    expect(layout.notesPath).toBe(path.join(layout.rootDir, "notes.md"));
    expect(layout.checksumsPath).toBe(path.join(layout.rootDir, "checksums.sha256"));
    expect(layout.publicJsonPath).toBeUndefined();
    expect(layout.changelogJsonPath).toBeUndefined();
    expect(layout.stableJsonPath).toBeUndefined();
  });

  test("resolves release version directories without overwriting other versions", () => {
    expect(resolveReleaseVersionDir("D:/repo", "releases", "0.3.2")).toBe(
      path.join("D:/repo", "releases", "v0.3.2"),
    );
    expect(resolveReleaseVersionDir("D:/repo", "release-output", "1.0.0-beta.1")).toBe(
      path.join("D:/repo", "release-output", "v1.0.0-beta.1"),
    );
  });

  test("classifies current Windows NSIS and MSI artifacts", () => {
    expect(classifyTauriArtifact("NexusPilot_0.3.2_x64-setup.exe", "0.3.2")).toEqual({
      platform: "windows-x86_64",
      bundle: "nsis",
      role: "installer",
    });

    expect(classifyTauriArtifact("NexusPilot_0.3.2_x64-setup.exe.sig", "0.3.2")).toEqual({
      platform: "windows-x86_64",
      bundle: "nsis",
      role: "signature",
    });

    expect(classifyTauriArtifact("NexusPilot_0.3.2_x64_en-US.msi", "0.3.2")).toEqual({
      platform: "windows-x86_64",
      bundle: "msi",
      role: "installer",
    });

    expect(classifyTauriArtifact("NexusPilot_0.3.1_x64-setup.exe", "0.3.2")).toBeNull();
  });
});
