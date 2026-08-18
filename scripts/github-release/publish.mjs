#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const product = "NexusPilot";
const channel = "stable";
export const S3_UPLOAD_MAX_ATTEMPTS = 4;
export const S3_MULTIPART_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const S3_MULTIPART_THRESHOLD_BYTES = S3_MULTIPART_PART_SIZE_BYTES;
const S3_RETRY_BASE_DELAY_MS = 500;
const S3_RETRY_MAX_DELAY_MS = 8_000;
const retryableS3ErrorCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "InternalError",
  "NetworkingError",
  "RequestTimeout",
  "RequestTimeoutException",
  "ServiceUnavailable",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TimeoutError",
  "TooManyRequestsException",
]);

const releaseTargets = [
  {
    artifactDirectory: "nexpilot-linux-x86_64",
    platform: "linux-x86_64",
    installers: [
      {
        bundle: "deb",
        matches: (name) => name.endsWith(".deb"),
        updaterPlatform: "linux-x86_64-deb",
      },
      {
        bundle: "rpm",
        matches: (name) => name.endsWith(".rpm"),
        updaterPlatform: "linux-x86_64-rpm",
      },
    ],
  },
  {
    artifactDirectory: "nexpilot-windows-x86_64",
    platform: "windows-x86_64",
    installers: [{
      bundle: "nsis",
      matches: (name) => /-setup\.exe$/i.test(name),
      updaterPlatform: "windows-x86_64",
    }],
  },
  {
    artifactDirectory: "nexpilot-darwin-x86_64",
    platform: "darwin-x86_64",
    installers: [{ bundle: "dmg", matches: (name) => name.endsWith(".dmg") }],
    updater: { bundle: "macos", matches: (name) => name.endsWith(".app.tar.gz") },
  },
  {
    artifactDirectory: "nexpilot-darwin-aarch64",
    platform: "darwin-aarch64",
    installers: [{ bundle: "dmg", matches: (name) => name.endsWith(".dmg") }],
    updater: { bundle: "macos", matches: (name) => name.endsWith(".app.tar.gz") },
  },
];

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

const downloadLabels = new Map([
  ["windows-x86_64/nsis", "Windows x64 安装包"],
  ["darwin-x86_64/dmg", "macOS Intel 安装包"],
  ["darwin-aarch64/dmg", "macOS Apple Silicon 安装包"],
  ["linux-x86_64/deb", "Linux x64 DEB 安装包"],
  ["linux-x86_64/rpm", "Linux x64 RPM 安装包"],
]);

function parseArgs(args) {
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const version = valueFor("--version");
  const inputDir = valueFor("--input");

  if (!version || !inputDir) {
    throw new Error("用法：bun scripts/github-release/publish.mjs --version <version> --input <artifact-dir> [--dry-run]");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`无效版本号：${version}`);
  }
  return { version, inputDir: path.resolve(inputDir), dryRun: args.includes("--dry-run") };
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

function normalizeUrl(baseUrl, relativePath) {
  return `${baseUrl.replace(/\/+$/g, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function findSingle(files, predicate, description) {
  const matches = files.filter((filePath) => predicate(path.basename(filePath)));
  if (matches.length !== 1) {
    throw new Error(`${description} 应恰好有一个文件，实际找到 ${matches.length} 个。`);
  }
  return matches[0];
}

function signatureFor(filePath, description) {
  const signaturePath = `${filePath}.sig`;
  if (!existsSync(signaturePath)) {
    throw new Error(`缺少 ${description} 的 Tauri 签名文件：${signaturePath}`);
  }
  return signaturePath;
}

function copyArtifact({ sourcePath, destinationDir, platform, bundle, role }) {
  const fileName = path.basename(sourcePath);
  const destinationPath = path.join(destinationDir, fileName);
  copyFileSync(sourcePath, destinationPath);
  return {
    destinationPath,
    relativePath: path.relative(path.dirname(destinationDir), destinationPath).replace(/\\/g, "/"),
    platform,
    bundle,
    role,
    size: statSync(destinationPath).size,
    sha256: sha256(destinationPath),
  };
}

export function collectArtifacts(inputDir, outputDir) {
  const artifacts = [];
  const updaterEntries = [];

  for (const target of releaseTargets) {
    const sourceDir = path.join(inputDir, target.artifactDirectory);
    const files = listFilesRecursive(sourceDir);
    if (files.length === 0) {
      throw new Error(`缺少 ${target.platform} 的 CI Artifact 目录：${sourceDir}`);
    }

    const platformDir = path.join(outputDir, target.platform);
    mkdirSync(platformDir, { recursive: true });

    for (const installer of target.installers) {
      const installerPath = findSingle(files, installer.matches, `${target.platform}/${installer.bundle} 安装包`);
      const copiedInstaller = copyArtifact({
        sourcePath: installerPath,
        destinationDir: platformDir,
        platform: target.platform,
        bundle: installer.bundle,
        role: "installer",
      });
      artifacts.push(copiedInstaller);

      if (installer.updaterPlatform) {
        const copiedSignature = copyArtifact({
          sourcePath: signatureFor(installerPath, `${target.platform}/${installer.bundle} 安装包`),
          destinationDir: platformDir,
          platform: target.platform,
          bundle: installer.bundle,
          role: "signature",
        });
        artifacts.push(copiedSignature);
        updaterEntries.push({
          platform: installer.updaterPlatform,
          artifact: copiedInstaller,
          signature: copiedSignature,
        });
      }
    }

    if (target.updater) {
      const updaterPath = findSingle(files, target.updater.matches, `${target.platform} updater 产物`);
      const copiedUpdater = copyArtifact({
        sourcePath: updaterPath,
        destinationDir: platformDir,
        platform: target.platform,
        bundle: target.updater.bundle,
        role: "updater",
      });
      const copiedSignature = copyArtifact({
        sourcePath: signatureFor(updaterPath, `${target.platform} updater 产物`),
        destinationDir: platformDir,
        platform: target.platform,
        bundle: target.updater.bundle,
        role: "updater-signature",
      });
      artifacts.push(copiedUpdater, copiedSignature);
      updaterEntries.push({ platform: target.platform, artifact: copiedUpdater, signature: copiedSignature });
    }
  }
  return { artifacts, updaterEntries };
}

function extractPublishedVersions(markdown) {
  const headings = [...markdown.matchAll(/^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/gm)];
  const published = headings.filter((heading) => heading[1] !== "Unreleased");

  return published.map((heading, index) => {
    const bodyStart = (heading.index ?? 0) + heading[0].length;
    const bodyEnd = index + 1 < published.length ? published[index + 1].index : markdown.length;
    const sections = [];
    let currentSection;

    for (const line of markdown.slice(bodyStart, bodyEnd).replace(/\r\n/g, "\n").split("\n")) {
      const sectionHeading = /^###\s+(.+?)\s*$/.exec(line);
      if (sectionHeading) {
        currentSection = { heading: sectionHeading[1], items: [] };
        sections.push(currentSection);
        continue;
      }
      const bullet = /^-\s+(.+?)\s*$/.exec(line);
      if (bullet && currentSection) currentSection.items.push(bullet[1]);
    }
    return { version: heading[1], date: heading[2], sections: sections.filter((section) => section.items.length > 0) };
  });
}

function formatNotes(versionSection) {
  const blocks = [`v${versionSection.version} 更新内容：`];
  for (const section of versionSection.sections) {
    blocks.push([
      updaterHeadings.get(section.heading) ?? section.heading,
      ...section.items.map((item) => `- ${item}`),
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

function createPublicVersion({ versionSection, artifacts = [], publicBaseUrl, tag }) {
  const downloads = artifacts.filter((artifact) => artifact.role === "installer").map((artifact) => {
    const signature = artifacts.find((candidate) => candidate.role === "signature"
      && candidate.platform === artifact.platform && candidate.bundle === artifact.bundle);
    const download = {
      platform: artifact.platform,
      bundle: artifact.bundle,
      label: downloadLabels.get(`${artifact.platform}/${artifact.bundle}`) ?? `${artifact.platform} ${artifact.bundle}`,
      url: normalizeUrl(publicBaseUrl, `${tag}/${artifact.relativePath}`),
      sha256: artifact.sha256,
      size: artifact.size,
      recommended: artifact.platform === "windows-x86_64" && artifact.bundle === "nsis",
    };
    return signature ? { ...download, signatureUrl: normalizeUrl(publicBaseUrl, `${tag}/${signature.relativePath}`) } : download;
  });
  const recommendedDownloadUrl = downloads.find((download) => download.recommended)?.url ?? downloads[0]?.url;

  return {
    version: versionSection.version,
    tag,
    pubDate: versionSection.date ? `${versionSection.date}T00:00:00Z` : undefined,
    summary: versionSection.sections[0]?.items[0] ?? "",
    sections: versionSection.sections.map((section) => ({
      ...(publicSectionMeta.get(section.heading) ?? { type: section.heading, title: section.heading, emoji: "" }),
      items: section.items,
    })),
    notesUrl: normalizeUrl(publicBaseUrl, `${tag}/notes.md`),
    downloads,
    ...(recommendedDownloadUrl ? { recommendedDownloadUrl } : {}),
    links: {
      checksums: normalizeUrl(publicBaseUrl, `${tag}/checksums.sha256`),
      versionIndex: normalizeUrl(publicBaseUrl, `${tag}/index.json`),
      versionUpdaterManifest: normalizeUrl(publicBaseUrl, `${tag}/latest.json`),
    },
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少 GitHub Actions secret：${name}`);
  return value;
}

function resolveConfig() {
  return {
    publicBaseUrl: requireEnv("CI_RELEASE_PUBLIC_BASE_URL").replace(/\/+$/g, ""),
    s3: {
      endpoint: requireEnv("CI_RELEASE_S3_ENDPOINT"),
      region: process.env.CI_RELEASE_S3_REGION?.trim() || "us-east-1",
      bucket: requireEnv("CI_RELEASE_S3_BUCKET"),
      prefix: requireEnv("CI_RELEASE_S3_PREFIX").replace(/^\/+|\/+$/g, ""),
      accessKeyId: requireEnv("CI_RELEASE_S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("CI_RELEASE_S3_SECRET_ACCESS_KEY"),
      forcePathStyle: (process.env.CI_RELEASE_S3_FORCE_PATH_STYLE ?? "true").toLowerCase() === "true",
    },
  };
}

function validateSourceVersion(version) {
  const versions = [
    ["package.json", JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version],
    ["src-tauri/tauri.conf.json", JSON.parse(readFileSync(path.join(rootDir, "src-tauri", "tauri.conf.json"), "utf8")).version],
    ["ai-runtime/package.json", JSON.parse(readFileSync(path.join(rootDir, "ai-runtime", "package.json"), "utf8")).version],
  ];
  const cargoToml = readFileSync(path.join(rootDir, "src-tauri", "Cargo.toml"), "utf8");
  versions.push(["src-tauri/Cargo.toml", /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1]]);
  const mismatches = versions.filter(([, current]) => current !== version);
  if (mismatches.length > 0) {
    throw new Error(`版本号必须同步为 ${version}：${mismatches.map(([file, current]) => `${file}=${current}`).join(", ")}`);
  }
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md") || filePath.endsWith(".sha256") || filePath.endsWith(".sig")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export function isRetryableS3Error(error) {
  if (!(error instanceof Error)) return false;

  const statusCode = error.$metadata?.httpStatusCode;
  if (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return true;
  }

  const codes = [error.name, error.code, error.cause?.code];
  return Boolean(error.$retryable) || codes.some((code) => retryableS3ErrorCodes.has(code));
}

export function s3RetryDelayMs(attempt, random = Math.random) {
  const exponentialDelay = Math.min(
    S3_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
    S3_RETRY_MAX_DELAY_MS,
  );
  return Math.round(exponentialDelay * (0.5 + random()));
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function retryS3Operation(operation, {
  description,
  maxAttempts = S3_UPLOAD_MAX_ATTEMPTS,
  random = Math.random,
  sleepFor = sleep,
  warn = console.warn,
} = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableS3Error(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = s3RetryDelayMs(attempt, random);
      const name = error instanceof Error ? error.name : "UnknownError";
      warn(`S3 临时失败：${description ?? "操作"}；将在 ${delayMs}ms 后重试（第 ${attempt + 1}/${maxAttempts} 次，${name}）。`);
      await sleepFor(delayMs);
    }
  }

  throw new Error(`S3 重试操作未能执行：${description ?? "操作"}`);
}

export function createMultipartUploadParts(totalBytes, partSize = S3_MULTIPART_PART_SIZE_BYTES) {
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new Error(`无效的 multipart 文件大小：${totalBytes}`);
  }
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`无效的 multipart 分片大小：${partSize}`);
  }

  const parts = [];
  let start = 0;
  let partNumber = 1;

  while (start < totalBytes) {
    const size = Math.min(partSize, totalBytes - start);
    parts.push({ partNumber, start, size });
    start += size;
    partNumber += 1;
  }

  return parts;
}

function readPartBuffer(fileDescriptor, part) {
  const buffer = Buffer.allocUnsafe(part.size);
  let offset = 0;

  while (offset < part.size) {
    const bytesRead = readSync(
      fileDescriptor,
      buffer,
      offset,
      part.size - offset,
      part.start + offset,
    );

    if (bytesRead === 0) {
      throw new Error(`读取发布产物失败：第 ${part.partNumber} 个分片读取不完整。`);
    }

    offset += bytesRead;
  }

  return buffer;
}

export async function putObjectMultipart({
  client,
  commands,
  bucket,
  key,
  filePath,
  totalBytes,
  contentType,
  cacheControl,
  partSize = S3_MULTIPART_PART_SIZE_BYTES,
}) {
  const {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
  } = commands;
  const createResult = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
  const uploadId = createResult.UploadId;

  if (!uploadId) {
    throw new Error(`对象存储没有返回 multipart upload id：${key}`);
  }

  const completedParts = [];
  const fileDescriptor = openSync(filePath, "r");
  let completed = false;

  try {
    for (const part of createMultipartUploadParts(totalBytes, partSize)) {
      const body = readPartBuffer(fileDescriptor, part);
      const result = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: part.partNumber,
        Body: body,
        ContentLength: body.length,
      }));

      if (!result.ETag) {
        throw new Error(`对象存储没有返回第 ${part.partNumber} 个分片的 ETag：${key}`);
      }

      completedParts.push({
        ETag: result.ETag,
        PartNumber: part.partNumber,
      });
    }

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: completedParts,
      },
    }));
    completed = true;
  } catch (error) {
    if (!completed) {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      })).catch(() => undefined);
    }
    throw error;
  } finally {
    closeSync(fileDescriptor);
  }
}

async function putObject({
  client,
  commands,
  bucket,
  key,
  filePath,
  contentType,
  cacheControl,
}) {
  const { PutObjectCommand } = commands;
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: readFileSync(filePath),
    ContentLength: statSync(filePath).size,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

function formatS3Error(error) {
  if (!(error instanceof Error)) return String(error);
  const status = error.$metadata?.httpStatusCode ? ` HTTP ${error.$metadata.httpStatusCode}` : "";
  const code = error.Code ?? error.code ?? error.name;
  return `${code}${status}: ${error.message}`;
}

export async function uploadObject({
  client,
  commands,
  bucket,
  key,
  filePath,
  cacheControl,
  multipartUploader = putObjectMultipart,
  warn = console.warn,
}) {
  const totalBytes = statSync(filePath).size;
  const contentType = contentTypeFor(filePath);

  if (totalBytes > S3_MULTIPART_THRESHOLD_BYTES) {
    console.log(`使用 multipart 上传 ${key}（${totalBytes} bytes）`);
    try {
      await multipartUploader({
        client,
        commands,
        bucket,
        key,
        filePath,
        totalBytes,
        contentType,
        cacheControl,
      });
      return;
    } catch (error) {
      console.log(`multipart 上传失败（${formatS3Error(error)}），回退到带 ContentLength 的 PutObject：${key}`);
      warn(`multipart 上传失败，回退到带 ContentLength 的 PutObject：${key}`);
    }
  }

  await putObject({ client, commands, bucket, key, filePath, contentType, cacheControl });
}

export async function verifyUploadedObject({ client, commands, bucket, key, filePath }) {
  const { HeadObjectCommand, ListObjectsV2Command } = commands;

  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 403) {
      throw error;
    }

    const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key }));
    const object = (result.Contents ?? []).find((entry) => entry.Key === key);
    const expectedSize = statSync(filePath).size;
    if (!object || object.Size !== expectedSize) {
      throw new Error(`对象存储校验失败：${key} 的 ListObjectsV2 结果不存在或大小不匹配（期望 ${expectedSize}，实际 ${object?.Size ?? "缺失"}）。`);
    }

    console.log(`HeadObject 返回 403，已通过 ListObjectsV2 校验 ${key}（${expectedSize} bytes）`);
  }
}

async function uploadAll({ outputDir, tag, config, dryRun }) {
  const versionedUploads = listFilesRecursive(outputDir).sort().map((filePath) => ({
    filePath,
    key: `${config.s3.prefix}/${tag}/${path.relative(outputDir, filePath).replace(/\\/g, "/")}`,
    cacheControl: "public, max-age=31536000, immutable",
  }));
  const mutableUploads = ["index.json", "latest.json"].map((fileName) => ({
    filePath: path.join(outputDir, fileName),
    key: `${config.s3.prefix}/${fileName}`,
    cacheControl: "no-cache",
  }));
  const uploads = [...versionedUploads, ...mutableUploads];

  if (dryRun) {
    uploads.forEach((upload) => console.log(`预览 ${upload.filePath} -> s3://${config.s3.bucket}/${upload.key}`));
    return;
  }

  const {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
  } = await import("@aws-sdk/client-s3");
  const commands = {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    PutObjectCommand,
    UploadPartCommand,
  };
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    maxAttempts: 1,
  });
  try {
    for (const upload of uploads) {
      await retryS3Operation(
        () => uploadObject({
          client,
          commands,
          bucket: config.s3.bucket,
          key: upload.key,
          filePath: upload.filePath,
          cacheControl: upload.cacheControl,
        }),
        { description: `上传 s3://${config.s3.bucket}/${upload.key}` },
      );
      await retryS3Operation(
        () => verifyUploadedObject({
          client,
          commands: { HeadObjectCommand, ListObjectsV2Command },
          bucket: config.s3.bucket,
          key: upload.key,
          filePath: upload.filePath,
        }),
        { description: `校验 s3://${config.s3.bucket}/${upload.key}` },
      );
      console.log(`已上传 s3://${config.s3.bucket}/${upload.key}`);
    }
  } finally {
    client.destroy();
  }
}

export async function publishRelease({ version, inputDir, dryRun = false }) {
  validateSourceVersion(version);
  const config = resolveConfig();
  const versions = extractPublishedVersions(readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"));
  const currentVersion = versions.find((entry) => entry.version === version);
  if (!currentVersion) throw new Error(`CHANGELOG.md 不包含 ${version} 对应的已发布版本段落。`);
  if (versions[0]?.version !== version) {
    throw new Error(`CI 只允许发布 CHANGELOG.md 中最新的版本；当前最新版本是 ${versions[0]?.version ?? "<缺失>"}。`);
  }

  const tag = `v${version}`;
  const outputDir = mkdtempSync(path.join(tmpdir(), `nexpilot-ci-release-${tag}-`));
  const { artifacts, updaterEntries } = collectArtifacts(inputDir, outputDir);
  const notes = formatNotes(currentVersion);
  const generatedAt = new Date().toISOString();
  const latestJson = {
    version,
    notes,
    pub_date: currentVersion.date ? `${currentVersion.date}T00:00:00Z` : generatedAt,
    platforms: Object.fromEntries(updaterEntries.map((entry) => [entry.platform, {
      signature: readFileSync(entry.signature.destinationPath, "utf8").trim(),
      url: normalizeUrl(config.publicBaseUrl, `${tag}/${entry.artifact.relativePath}`),
    }])),
  };
  const currentPublicVersion = createPublicVersion({
    versionSection: currentVersion,
    artifacts,
    publicBaseUrl: config.publicBaseUrl,
    tag,
  });
  const publicIndex = {
    schemaVersion: 1,
    product,
    channel,
    generatedAt,
    latest: { version, tag },
    versions: versions.map((entry) => entry.version === version
      ? currentPublicVersion
      : createPublicVersion({ versionSection: entry, publicBaseUrl: config.publicBaseUrl, tag: `v${entry.version}` })),
  };
  const checksums = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.relativePath}`).join("\n");

  writeFileSync(path.join(outputDir, "notes.md"), `${notes}\n`);
  writeFileSync(path.join(outputDir, "latest.json"), `${JSON.stringify(latestJson, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "index.json"), `${JSON.stringify(publicIndex, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "checksums.sha256"), `${checksums}\n`);
  await uploadAll({ outputDir, tag, config, dryRun });
  return { outputDir, artifacts, latestJson, publicIndex };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await publishRelease(args);
  console.log(`CI 发布${args.dryRun ? "预览" : "完成"}：${result.artifacts.length} 个归档文件，${Object.keys(result.latestJson.platforms).length} 个 updater 平台。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(formatS3Error(error));
    process.exit(1);
  });
}
