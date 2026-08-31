import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compareReleaseAssets,
  prepareGitHubAssets,
  publishGitHubRelease,
} from "./publish-to-github.mjs";

const fixtureFiles = {
  "linux-x86_64": ["NexusPilot_1.2.3_amd64.deb", "NexusPilot-1.2.3.x86_64.rpm"],
  "windows-x86_64": ["NexusPilot_1.2.3_x64-setup.exe", "NexusPilot_1.2.3_x64-setup.exe.sig"],
  "darwin-x86_64": ["NexusPilot_1.2.3_x64.dmg", "NexusPilot.app.tar.gz", "NexusPilot.app.tar.gz.sig"],
  "darwin-aarch64": ["NexusPilot_1.2.3_aarch64.dmg", "NexusPilot.app.tar.gz", "NexusPilot.app.tar.gz.sig"],
};

function writeReleaseFixture() {
  const inputDir = mkdtempSync(path.join(tmpdir(), "nexpilot-github-input-"));
  writeFileSync(path.join(inputDir, "notes.md"), "Release notes\n");
  for (const [platform, names] of Object.entries(fixtureFiles)) {
    const platformDir = path.join(inputDir, platform);
    mkdirSync(platformDir, { recursive: true });
    for (const name of names) {
      writeFileSync(path.join(platformDir, name), `${platform}/${name}`);
    }
  }
  return inputDir;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createGitHubMock(initialRelease) {
  const calls = [];
  let release = initialRelease;

  const runGh = (args) => {
    calls.push(args);
    const operation = `${args[0]} ${args[1]}`;

    if (operation === "release view") {
      if (!release) return { status: 1, stdout: "", stderr: "release not found" };
      return { status: 0, stdout: JSON.stringify(release), stderr: "" };
    }

    if (operation === "release create") {
      const titleIndex = args.indexOf("--title");
      const notesIndex = args.indexOf("--notes-file");
      release = {
        assets: [],
        body: readFileSync(args[notesIndex + 1], "utf8").trim(),
        isDraft: true,
        isPrerelease: args.includes("--prerelease"),
        name: args[titleIndex + 1],
        url: "https://github.example.test/releases/v1.2.3",
      };
      return { status: 0, stdout: release.url, stderr: "" };
    }

    if (operation === "release upload") {
      const repositoryIndex = args.indexOf("--repo");
      const paths = args.slice(3, repositoryIndex);
      release.assets = paths.map((filePath) => ({
        name: path.basename(filePath),
        size: statSync(filePath).size,
        digest: `sha256:${sha256(filePath)}`,
      }));
      return { status: 0, stdout: "", stderr: "" };
    }

    if (operation === "release edit") {
      if (args.includes("--draft=false")) release.isDraft = false;
      const titleIndex = args.indexOf("--title");
      if (titleIndex >= 0) release.name = args[titleIndex + 1];
      const notesIndex = args.indexOf("--notes-file");
      if (notesIndex >= 0) release.body = readFileSync(args[notesIndex + 1], "utf8").trim();
      const prereleaseFlag = args.find((arg) => arg.startsWith("--prerelease="));
      if (prereleaseFlag) release.isPrerelease = prereleaseFlag.endsWith("true");
      return { status: 0, stdout: "", stderr: "" };
    }

    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  return { calls, getRelease: () => release, runGh };
}

describe("GitHub Release asset preparation", () => {
  test("flattens platform artifacts and prefixes only colliding names", () => {
    const inputDir = writeReleaseFixture();
    const stagingDir = mkdtempSync(path.join(tmpdir(), "nexpilot-github-assets-"));

    const result = prepareGitHubAssets(inputDir, stagingDir);
    const names = result.assets.map((asset) => asset.name);

    expect(names).toContain("NexusPilot_1.2.3_x64.dmg");
    expect(names).toContain("darwin-x86_64-NexusPilot.app.tar.gz");
    expect(names).toContain("darwin-aarch64-NexusPilot.app.tar.gz");
    expect(names).not.toContain("NexusPilot.app.tar.gz");
    expect(names).toContain("checksums.sha256");
    expect(existsSync(path.join(stagingDir, "checksums.sha256"))).toBe(true);

    const checksums = readFileSync(path.join(stagingDir, "checksums.sha256"), "utf8");
    expect(checksums).toContain("darwin-x86_64-NexusPilot.app.tar.gz");
    expect(checksums).toContain("darwin-aarch64-NexusPilot.app.tar.gz.sig");
  });

  test("reports missing, unexpected, and size-mismatched release assets", () => {
    const difference = compareReleaseAssets(
      { assets: [
        { name: "one.bin", size: 5, digest: "sha256:remote" },
        { name: "extra.bin", size: 1, digest: "sha256:extra" },
      ] },
      [
        { name: "one.bin", size: 4, sha256: "local" },
        { name: "missing.bin", size: 2, sha256: "missing" },
      ],
    );

    expect(difference.matches).toBe(false);
    expect(difference.missing).toEqual(["missing.bin"]);
    expect(difference.unexpected).toEqual(["extra.bin"]);
    expect(difference.sizeMismatches).toEqual(["one.bin（期望 4，实际 5）"]);
    expect(difference.digestMismatches).toEqual(["one.bin"]);
  });
});

describe("GitHub Release publishing", () => {
  test("creates a draft, uploads and verifies assets, then publishes it", () => {
    const inputDir = writeReleaseFixture();
    const github = createGitHubMock();

    const result = publishGitHubRelease({
      tag: "v1.2.3",
      inputDir,
      repository: "owner/repository",
      runGh: github.runGh,
    });

    expect(result.status).toBe("published");
    expect(github.getRelease().isDraft).toBe(false);
    expect(github.calls.find((args) => args[1] === "create")).toContain("--verify-tag");
    expect(github.calls.find((args) => args[1] === "upload")).toContain("--clobber");
    expect(github.calls.find((args) => args.includes("--draft=false"))).toContain("--latest=true");
  });

  test("marks semantic prereleases as prerelease and not latest", () => {
    const inputDir = writeReleaseFixture();
    const github = createGitHubMock();

    publishGitHubRelease({
      tag: "v1.2.3-beta.1",
      inputDir,
      repository: "owner/repository",
      runGh: github.runGh,
    });

    expect(github.calls.find((args) => args[1] === "create")).toContain("--prerelease");
    expect(github.calls.find((args) => args.includes("--draft=false"))).toContain("--latest=false");
    expect(github.getRelease().isPrerelease).toBe(true);
  });

  test("resumes an existing draft and repairs its metadata and assets", () => {
    const inputDir = writeReleaseFixture();
    const github = createGitHubMock({
      assets: [],
      body: "stale notes",
      isDraft: true,
      isPrerelease: true,
      name: "stale title",
      url: "https://github.example.test/releases/v1.2.3",
    });

    const result = publishGitHubRelease({
      tag: "v1.2.3",
      inputDir,
      repository: "owner/repository",
      runGh: github.runGh,
    });

    expect(result.status).toBe("published");
    expect(github.getRelease().name).toBe("NexusPilot v1.2.3");
    expect(github.getRelease().body).toBe("Release notes");
    expect(github.getRelease().isPrerelease).toBe(false);
  });

  test("accepts an already-published exact match without mutating it", () => {
    const inputDir = writeReleaseFixture();
    const prepared = prepareGitHubAssets(inputDir);
    const github = createGitHubMock({
      assets: prepared.assets.map((asset) => ({
        name: asset.name,
        size: asset.size,
        digest: `sha256:${asset.sha256}`,
      })),
      body: "Release notes",
      isDraft: false,
      isPrerelease: false,
      name: "NexusPilot v1.2.3",
      url: "https://github.example.test/releases/v1.2.3",
    });

    const result = publishGitHubRelease({
      tag: "v1.2.3",
      inputDir,
      repository: "owner/repository",
      runGh: github.runGh,
    });

    expect(result.status).toBe("unchanged");
    expect(github.calls.every((args) => args[1] === "view")).toBe(true);
  });

  test("refuses to overwrite a mismatched published release", () => {
    const inputDir = writeReleaseFixture();
    const prepared = prepareGitHubAssets(inputDir);
    const publishedAssets = prepared.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      digest: `sha256:${asset.sha256}`,
    }));
    publishedAssets[0].digest = "sha256:different";
    const github = createGitHubMock({
      assets: publishedAssets,
      body: "Release notes",
      isDraft: false,
      isPrerelease: false,
      name: "NexusPilot v1.2.3",
      url: "https://github.example.test/releases/v1.2.3",
    });

    expect(() => publishGitHubRelease({
      tag: "v1.2.3",
      inputDir,
      repository: "owner/repository",
      runGh: github.runGh,
    })).toThrow("拒绝覆盖正式 Release");
    expect(github.calls.every((args) => args[1] === "view")).toBe(true);
  });
});
