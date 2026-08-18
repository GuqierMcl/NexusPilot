const headingPattern = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const sectionHeadingPattern = /^###\s+(.+?)\s*$/;
const bulletPattern = /^-\s+(.+?)\s*$/;

const updaterHeadings = new Map([
  ["Feature", "✨ 新功能"],
  ["Optimization", "⚡ 优化"],
  ["Fixed", "🐛 修复"],
  ["Added", "✨ 新功能"],
  ["Changed", "⚡ 优化"],
  ["Deprecated", "⚠️ 即将废弃"],
  ["Removed", "🗑️ 移除"],
  ["Security", "🔒 安全"],
]);

const publicSectionMeta = new Map([
  ["Feature", { type: "Added", title: "新功能", emoji: "✨" }],
  ["Optimization", { type: "Changed", title: "改进", emoji: "🔧" }],
  ["Added", { type: "Added", title: "新功能", emoji: "✨" }],
  ["Changed", { type: "Changed", title: "改进", emoji: "🔧" }],
  ["Deprecated", { type: "Deprecated", title: "即将废弃", emoji: "⚠️" }],
  ["Removed", { type: "Removed", title: "移除", emoji: "🗑️" }],
  ["Fixed", { type: "Fixed", title: "修复", emoji: "🐛" }],
  ["Security", { type: "Security", title: "安全", emoji: "🔒" }],
]);

export function extractVersionSection(markdown, version) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const startIndex = lines.findIndex((line) => {
    const match = headingPattern.exec(line);
    return match?.[1] === version;
  });

  if (startIndex < 0) {
    throw new Error(`CHANGELOG.md 不包含 ${version} 对应的版本段落。`);
  }

  const heading = headingPattern.exec(lines[startIndex]);
  const endIndex = lines.findIndex((line, index) => index > startIndex && headingPattern.test(line));
  const bodyLines = lines.slice(startIndex + 1, endIndex < 0 ? lines.length : endIndex);
  const sections = [];
  let currentSection;

  for (const line of bodyLines) {
    const sectionMatch = sectionHeadingPattern.exec(line);
    if (sectionMatch) {
      currentSection = {
        heading: sectionMatch[1],
        items: [],
      };
      sections.push(currentSection);
      continue;
    }

    const bulletMatch = bulletPattern.exec(line);
    if (bulletMatch && currentSection) {
      currentSection.items.push(bulletMatch[1]);
    }
  }

  return {
    version,
    date: heading?.[2],
    sections: sections.filter((section) => section.items.length > 0),
  };
}

export function extractPublishedVersions(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const versions = [];

  for (const line of lines) {
    const match = headingPattern.exec(line);

    if (!match || match[1] === "Unreleased") {
      continue;
    }

    versions.push(extractVersionSection(markdown, match[1]));
  }

  return versions;
}

export function toPublicChangelogSections(sections) {
  return sections
    .map((section) => {
      const meta = publicSectionMeta.get(section.heading) ?? {
        type: section.heading,
        title: section.heading,
        emoji: "",
      };

      return {
        type: meta.type,
        title: meta.title,
        emoji: meta.emoji,
        items: section.items,
      };
    })
    .filter((section) => section.items.length > 0);
}

export function createPublicReleaseSummary(section) {
  for (const changelogSection of section.sections) {
    const firstItem = changelogSection.items[0];

    if (firstItem) {
      return firstItem;
    }
  }

  return "";
}

export function formatUpdaterNotes(section) {
  const blocks = [`v${section.version} 更新内容：`];

  for (const changelogSection of section.sections) {
    const title = updaterHeadings.get(changelogSection.heading) ?? changelogSection.heading;
    const items = changelogSection.items.map((item) => `- ${item}`);
    blocks.push([title, ...items].join("\n"));
  }

  return blocks.join("\n\n");
}

export function rotateUnreleasedSection(markdown, version, date) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const startIndex = lines.findIndex((line) => {
    const match = headingPattern.exec(line);
    return match?.[1] === "Unreleased";
  });

  if (startIndex < 0) {
    throw new Error("CHANGELOG.md 不包含 [Unreleased] 段落。");
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && headingPattern.test(line));
  const body = lines
    .slice(startIndex + 1, endIndex < 0 ? lines.length : endIndex)
    .join("\n")
    .trim();
  const unreleasedSection = extractVersionSection(normalized, "Unreleased");

  if (unreleasedSection.sections.length === 0) {
    throw new Error("[Unreleased] 不包含任何 release-note 条目。");
  }

  const before = lines.slice(0, startIndex).join("\n").trimEnd();
  const after = lines.slice(endIndex < 0 ? lines.length : endIndex).join("\n").trimStart();
  const freshUnreleased = "## [Unreleased]\n\n### Feature\n\n### Optimization\n\n### Fixed";
  const released = [`## [${version}] - ${date}`, body].filter(Boolean).join("\n\n");

  return [before, freshUnreleased, released, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trimEnd() + "\n";
}
