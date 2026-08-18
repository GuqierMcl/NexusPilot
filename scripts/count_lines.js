#!/usr/bin/env node
/** 统计仓库代码行数，按语言分类输出。 */

import { execSync } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const LANG_MAP = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".css": "CSS",
  ".html": "HTML",
  ".json": "JSON",
  ".md": "Markdown",
  ".toml": "TOML",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".sql": "SQL",
  ".svg": "SVG",
  ".xml": "XML",
};

const SKIP_EXTENSIONS = new Set([
  ".png", ".ico", ".icns", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".map", ".lock", ".tsbuildinfo",
]);

function getTrackedFiles() {
  try {
    const out = execSync(
      "git ls-files --cached --others --exclude-standard",
      { cwd: ROOT, encoding: "utf8" }
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((f) => join(ROOT, f));
  } catch {
    const walk = (dir, list = []) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        statSync(p).isDirectory() ? walk(p, list) : list.push(p);
      }
      return list;
    };
    return walk(ROOT);
  }
}

function countFile(filePath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [0, 0, 0];
  }
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const blank = lines.filter((l) => !l.trim()).length;
  const comment = countComments(extname(filePath).toLowerCase(), lines);
  return [total, blank, comment];
}

function countComments(ext, lines) {
  const commentChar =
    [".py", ".toml", ".yaml", ".yml"].includes(ext) ? "#" :
    [".ts", ".tsx", ".js", ".jsx", ".rs", ".css"].includes(ext) ? "//" :
    ext === ".sql" ? "--" :
    null;
  if (!commentChar) return 0;
  return lines.filter((l) => l.trimStart().startsWith(commentChar)).length;
}

function classify(ext) {
  return LANG_MAP[ext] || "Other";
}

function main() {
  const files = getTrackedFiles();
  const stats = {};

  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;

    const lang = classify(ext);
    if (!stats[lang]) stats[lang] = { files: 0, total: 0, blank: 0, comment: 0 };

    const [total, blank, comment] = countFile(f);
    if (total === 0) continue;

    stats[lang].files += 1;
    stats[lang].total += total;
    stats[lang].blank += blank;
    stats[lang].comment += comment;
  }

  const hdr = (s, w) => s.padStart(w);
  console.log(
    `${"Language".padEnd(18)} ${hdr("Files", 6)} ${hdr("Total", 8)} ${hdr("Blank", 8)} ${hdr("Comment", 8)} ${hdr("Code", 8)}`
  );
  console.log("-".repeat(60));

  let grandFiles = 0, grandTotal = 0, grandBlank = 0, grandComment = 0;
  for (const lang of Object.keys(stats).sort()) {
    const s = stats[lang];
    const code = s.total - s.blank - s.comment;
    console.log(
      `${lang.padEnd(18)} ${hdr(String(s.files), 6)} ${hdr(String(s.total), 8)} ${hdr(String(s.blank), 8)} ${hdr(String(s.comment), 8)} ${hdr(String(code), 8)}`
    );
    grandFiles += s.files;
    grandTotal += s.total;
    grandBlank += s.blank;
    grandComment += s.comment;
  }

  console.log("-".repeat(60));
  const grandCode = grandTotal - grandBlank - grandComment;
  console.log(
    `${"Total".padEnd(18)} ${hdr(String(grandFiles), 6)} ${hdr(String(grandTotal), 8)} ${hdr(String(grandBlank), 8)} ${hdr(String(grandComment), 8)} ${hdr(String(grandCode), 8)}`
  );
}

main();
