#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const product = "NexusPilot";
const platformDirectories = [
  "linux-x86_64",
  "windows-x86_64",
  "darwin-x86_64",
  "darwin-aarch64",
];
const githubReleaseAssetLimit = 1_000;
const githubReleaseAssetSizeLimit = 2 * 1024 * 1024 * 1024;

function parseArgs(args, env = process.env) {
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const tag = valueFor("--tag");
  const inputDir = valueFor("--input");
  const repository = valueFor("--repository") ?? env.GITHUB_REPOSITORY;

  if (!tag || !inputDir || !repository) {
    throw new Error("用法：bun scripts/github-release/publish-to-github.mjs --tag <vX.Y.Z> --input <release-dir> [--repository <owner/repo>]");
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`无效发布 tag：${tag}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`无效 GitHub 仓库：${repository}`);
  }
  return { tag, inputDir: path.resolve(inputDir), repository };
}

function listFilesRecursive(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursive(entryPath) : entry.isFile() ? [entryPath] : [];
  });
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function ensureAssetLimits(assets) {
  if (assets.length > githubReleaseAssetLimit) {
    throw new Error(`GitHub Release 资产数量超过 ${githubReleaseAssetLimit} 个：${assets.length}`);
  }
  for (const asset of assets) {
    if (asset.size >= githubReleaseAssetSizeLimit) {
      throw new Error(`GitHub Release 单个资产必须小于 2 GiB：${asset.name}`);
    }
  }
}

export function prepareGitHubAssets(inputDir, stagingDir) {
  const resolvedInputDir = path.resolve(inputDir);
  const notesPath = path.join(resolvedInputDir, "notes.md");
  if (!existsSync(notesPath)) {
    throw new Error(`缺少 GitHub Release notes：${notesPath}`);
  }

  const sourceAssets = platformDirectories.flatMap((platform) => {
    const platformDir = path.join(resolvedInputDir, platform);
    const files = listFilesRecursive(platformDir);
    if (files.length === 0) {
      throw new Error(`缺少 GitHub Release 平台产物：${platformDir}`);
    }
    return files.map((sourcePath) => ({ platform, sourcePath, originalName: path.basename(sourcePath) }));
  });

  const basenameCounts = new Map();
  for (const asset of sourceAssets) {
    const key = asset.originalName.toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  }

  const resolvedStagingDir = stagingDir
    ? path.resolve(stagingDir)
    : mkdtempSync(path.join(tmpdir(), "nexpilot-github-release-"));
  mkdirSync(resolvedStagingDir, { recursive: true });

  const stagedAssets = sourceAssets.map((asset) => {
    const duplicate = (basenameCounts.get(asset.originalName.toLowerCase()) ?? 0) > 1;
    const name = duplicate ? `${asset.platform}-${asset.originalName}` : asset.originalName;
    const filePath = path.join(resolvedStagingDir, name);
    copyFileSync(asset.sourcePath, filePath);
    return { name, filePath, size: statSync(filePath).size, sha256: sha256(filePath) };
  });

  const names = stagedAssets.map((asset) => asset.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    throw new Error("GitHub Release 资产消歧后仍存在重名文件。");
  }

  stagedAssets.sort((left, right) => left.name.localeCompare(right.name));
  const checksumsPath = path.join(resolvedStagingDir, "checksums.sha256");
  writeFileSync(
    checksumsPath,
    `${stagedAssets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
  );
  stagedAssets.push({
    name: "checksums.sha256",
    filePath: checksumsPath,
    size: statSync(checksumsPath).size,
    sha256: sha256(checksumsPath),
  });
  ensureAssetLimits(stagedAssets);

  return { assets: stagedAssets, notesPath, stagingDir: resolvedStagingDir };
}

export function executeGitHubCli(args, { allowFailure = false, env = process.env } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  const status = result.status ?? 1;
  const commandResult = {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  if (status !== 0 && !allowFailure) {
    throw new Error(`GitHub CLI 执行失败（gh ${args.slice(0, 3).join(" ")}）：${commandResult.stderr.trim() || `exit ${status}`}`);
  }
  return commandResult;
}

function parseRelease(result, tag) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`无法解析 ${tag} 的 GitHub Release 状态：${error instanceof Error ? error.message : String(error)}`);
  }
}

function getRelease({ tag, repository, runGh }) {
  const result = runGh([
    "release",
    "view",
    tag,
    "--repo",
    repository,
    "--json",
    "assets,body,isDraft,isPrerelease,name,url",
  ], { allowFailure: true });
  if (result.status === 0) return parseRelease(result, tag);

  const failure = `${result.stdout}\n${result.stderr}`;
  if (/release not found|HTTP 404|not found/i.test(failure)) return undefined;
  throw new Error(`读取 ${tag} 的 GitHub Release 失败：${result.stderr.trim() || `exit ${result.status}`}`);
}

export function compareReleaseAssets(release, expectedAssets) {
  const expected = new Map(expectedAssets.map((asset) => [asset.name, asset]));
  const actual = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  const missing = [...expected].filter(([name]) => !actual.has(name)).map(([name]) => name);
  const unexpected = [...actual].filter(([name]) => !expected.has(name)).map(([name]) => name);
  const sizeMismatches = [...expected]
    .filter(([name, asset]) => actual.has(name) && actual.get(name).size !== asset.size)
    .map(([name, asset]) => `${name}（期望 ${asset.size}，实际 ${actual.get(name).size}）`);
  const digestMismatches = [...expected]
    .filter(([name, asset]) => actual.has(name) && actual.get(name).digest !== `sha256:${asset.sha256}`)
    .map(([name]) => name);
  return {
    matches: missing.length === 0
      && unexpected.length === 0
      && sizeMismatches.length === 0
      && digestMismatches.length === 0,
    missing,
    unexpected,
    sizeMismatches,
    digestMismatches,
  };
}

function formatAssetDifference(difference) {
  return [
    difference.missing.length > 0 ? `缺少：${difference.missing.join(", ")}` : undefined,
    difference.unexpected.length > 0 ? `多余：${difference.unexpected.join(", ")}` : undefined,
    difference.sizeMismatches.length > 0 ? `大小不一致：${difference.sizeMismatches.join(", ")}` : undefined,
    difference.digestMismatches.length > 0 ? `SHA-256 不一致：${difference.digestMismatches.join(", ")}` : undefined,
  ].filter(Boolean).join("；");
}

export function publishGitHubRelease({ tag, inputDir, repository, runGh = executeGitHubCli, stagingDir }) {
  const prerelease = tag.slice(1).includes("-");
  const title = `${product} ${tag}`;
  const { assets, notesPath } = prepareGitHubAssets(inputDir, stagingDir);
  const notes = readFileSync(notesPath, "utf8").trim();
  let release = getRelease({ tag, repository, runGh });

  if (release && !release.isDraft) {
    const difference = compareReleaseAssets(release, assets);
    const metadataMatches = release.isPrerelease === prerelease
      && release.name === title
      && (release.body ?? "").trim() === notes;
    if (!difference.matches || !metadataMatches) {
      throw new Error(`已发布的 ${tag} 与本地产物或元数据不一致，拒绝覆盖正式 Release。${difference.matches ? "" : ` ${formatAssetDifference(difference)}`}`);
    }
    return { assets, release, status: "unchanged" };
  }

  if (!release) {
    const createArgs = [
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--draft",
      "--verify-tag",
      "--title",
      title,
      "--notes-file",
      notesPath,
    ];
    if (prerelease) createArgs.push("--prerelease", "--latest=false");
    runGh(createArgs);
  } else {
    runGh([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--title",
      title,
      "--notes-file",
      notesPath,
      `--prerelease=${prerelease}`,
    ]);
  }

  runGh([
    "release",
    "upload",
    tag,
    ...assets.map((asset) => asset.filePath),
    "--repo",
    repository,
    "--clobber",
  ]);

  release = getRelease({ tag, repository, runGh });
  if (!release?.isDraft) {
    throw new Error(`上传后未找到 ${tag} 的 GitHub Release 草稿。`);
  }
  const difference = compareReleaseAssets(release, assets);
  if (!difference.matches) {
    throw new Error(`GitHub Release 资产校验失败：${formatAssetDifference(difference)}`);
  }

  runGh([
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    `--latest=${!prerelease}`,
  ]);

  release = getRelease({ tag, repository, runGh });
  if (!release || release.isDraft || release.isPrerelease !== prerelease) {
    throw new Error(`${tag} 的 GitHub Release 最终状态校验失败。`);
  }
  return { assets, release, status: "published" };
}

function main() {
  if (!process.env.GH_TOKEN) {
    throw new Error("缺少 GH_TOKEN，无法发布 GitHub Release。");
  }
  const args = parseArgs(process.argv.slice(2));
  const result = publishGitHubRelease(args);
  console.log(`GitHub Release ${result.status === "published" ? "发布完成" : "已存在且校验通过"}：${args.tag}，${result.assets.length} 个资产。`);
  if (result.release.url) console.log(result.release.url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
