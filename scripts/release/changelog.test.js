import { describe, expect, test } from "bun:test";

import {
  createPublicReleaseSummary,
  extractPublishedVersions,
  extractVersionSection,
  formatUpdaterNotes,
  rotateUnreleasedSection,
  toPublicChangelogSections,
} from "./changelog.mjs";

const sampleChangelog = `# Changelog

## [Unreleased]

### Feature

- 新增待发布能力。

## [0.3.2] - 2026-07-02

### Feature

- 新增发布产物集中归档流程。

### Optimization

- 收敛 release 脚本入口。

### Fixed

- 修复 latest.json 手动维护容易遗漏的问题。

## [0.3.1] - 2026-06-29

### Optimization

- 优化更新提示。
`;

describe("release changelog helpers", () => {
  test("extracts one version section from NexusPilot release category markdown", () => {
    const section = extractVersionSection(sampleChangelog, "0.3.2");

    expect(section.version).toBe("0.3.2");
    expect(section.date).toBe("2026-07-02");
    expect(section.sections).toEqual([
      {
        heading: "Feature",
        items: ["新增发布产物集中归档流程。"],
      },
      {
        heading: "Optimization",
        items: ["收敛 release 脚本入口。"],
      },
      {
        heading: "Fixed",
        items: ["修复 latest.json 手动维护容易遗漏的问题。"],
      },
    ]);
  });

  test("extracts all published changelog versions and skips Unreleased", () => {
    const versions = extractPublishedVersions(sampleChangelog);

    expect(versions.map((version) => version.version)).toEqual(["0.3.2", "0.3.1"]);
    expect(versions[0].date).toBe("2026-07-02");
    expect(versions[0].sections[0]).toEqual({
      heading: "Feature",
      items: ["新增发布产物集中归档流程。"],
    });
  });

  test("maps release-note headings to public website sections", () => {
    const section = extractVersionSection(sampleChangelog, "0.3.2");

    expect(toPublicChangelogSections(section.sections)).toEqual([
      {
        type: "Added",
        title: "新功能",
        emoji: "✨",
        items: ["新增发布产物集中归档流程。"],
      },
      {
        type: "Changed",
        title: "改进",
        emoji: "🔧",
        items: ["收敛 release 脚本入口。"],
      },
      {
        type: "Fixed",
        title: "修复",
        emoji: "🐛",
        items: ["修复 latest.json 手动维护容易遗漏的问题。"],
      },
    ]);
  });

  test("creates a short public summary from the first visible release note", () => {
    const section = extractVersionSection(sampleChangelog, "0.3.2");

    expect(createPublicReleaseSummary(section)).toBe("新增发布产物集中归档流程。");
  });

  test("formats updater notes with friendly emoji headings", () => {
    const section = extractVersionSection(sampleChangelog, "0.3.2");

    expect(formatUpdaterNotes(section)).toBe(`v0.3.2 更新内容：

✨ 新功能
- 新增发布产物集中归档流程。

⚡ 优化
- 收敛 release 脚本入口。

🐛 修复
- 修复 latest.json 手动维护容易遗漏的问题。`);
  });

  test("formats legacy Keep a Changelog headings as compatible updater notes", () => {
    const section = extractVersionSection(`# Changelog

## [0.3.0] - 2026-06-28

### Added

- 新增旧分类能力。

### Changed

- 优化旧分类流程。

### Fixed

- 修复旧分类问题。
`, "0.3.0");

    expect(formatUpdaterNotes(section)).toBe(`v0.3.0 更新内容：

✨ 新功能
- 新增旧分类能力。

⚡ 优化
- 优化旧分类流程。

🐛 修复
- 修复旧分类问题。`);
  });

  test("rotates Unreleased into a dated version and creates a fresh Unreleased section", () => {
    const rotated = rotateUnreleasedSection(sampleChangelog, "0.3.3", "2026-07-03");

    expect(rotated).toContain("## [Unreleased]\n\n### Feature\n\n### Optimization\n\n### Fixed\n\n");
    expect(rotated).toContain("## [0.3.3] - 2026-07-03\n\n### Feature\n\n- 新增待发布能力。");
    expect(rotated.indexOf("## [Unreleased]")).toBeLessThan(rotated.indexOf("## [0.3.3]"));
  });

  test("rejects rotating an empty Unreleased section", () => {
    expect(() =>
      rotateUnreleasedSection(`# Changelog

## [Unreleased]

### Feature

### Optimization

### Fixed
`, "0.3.3", "2026-07-03"),
    ).toThrow("[Unreleased] 不包含任何 release-note 条目");
  });
});
