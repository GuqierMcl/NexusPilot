import { describe, expect, test } from "bun:test";

import { getHelpText } from "./help.mjs";

describe("release help", () => {
  test("documents the complete local release flow in Chinese", () => {
    const help = getHelpText({ color: false });

    expect(help).toContain("NexusPilot 发布助手");
    expect(help).toContain("bun run release doctor");
    expect(help).toContain("bun run release prepare <patch|minor|major|prerelease|prepatch|preminor|premajor|x.y.z>");
    expect(help).not.toContain("3. bun run release prepare patch");
    expect(help).not.toContain("检查 CHANGELOG.md 和 git diff");
    expect(help).toContain("bun run release publish --dry-run");
    expect(help).toContain("CHANGELOG.md");
    expect(help).toContain(".env.release.local");
    expect(help).toContain("releases/vX.Y.Z");
    expect(help).toContain("releases/vX.Y.Z/index.json");
    expect(help).toContain("releases/vX.Y.Z/notes.md");
    expect(help).toContain("远端 releases/index.json");
    expect(help).not.toContain("public.json");
    expect(help).not.toContain("changelog.json");
    expect(help).not.toContain("channels/stable.json");
    expect(help).toContain("公开发布索引");
    expect(help).toContain("典型流程");
    expect(help).toContain("命令");
    expect(help).toContain("GitHub Actions 跨平台 CI 发布");
    expect(help).toContain("Desktop S3 Release");
    expect(help).toContain("v* tag");
    expect(help).toContain("自动触发");
    expect(help).toContain("自动发布到对象存储");
    expect(help).not.toContain("publish=false");
    expect(help).not.toContain("publish=true");
    expect(help).toContain("linux-x86_64-deb");
    expect(help).toContain("linux-x86_64-rpm");
    expect(help).toContain("dl.nexuspilot.dev");
    expect(help).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(help).toContain("CI_RELEASE_S3_*");
    expect(help).toContain("文件");
    expect(help).not.toContain("Typical flow");
  });

  test("can render important help text with ANSI emphasis and colors", () => {
    const help = getHelpText({ color: true });

    expect(help).toContain("\x1b[1m");
    expect(help).toContain("\x1b[36m");
    expect(help).toContain("\x1b[33m");
    expect(help).toContain("\x1b[0m");
  });
});
