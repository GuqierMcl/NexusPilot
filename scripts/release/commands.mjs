import { createHash } from "node:crypto";
import {
  existsSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { clearLine, cursorTo } from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { computeNextVersion } from "../version-utils.js";
import {
  copyArtifactsToLayout,
  createReleaseLayout,
  discoverTauriArtifacts,
  findUpdaterArtifact,
} from "./artifacts.mjs";
import {
  extractPublishedVersions,
  extractVersionSection,
  formatUpdaterNotes,
  rotateUnreleasedSection,
} from "./changelog.mjs";
import {
  getMaskedConfigSummary,
  hasReleaseConfigValue,
  loadEnvFile,
  resolveReleaseConfig,
} from "./env.mjs";
import {
  createLatestJson,
  createReleaseManifest,
  createSha256Manifest,
} from "./manifest.mjs";
import {
  createPublicReleaseIndex,
  createPublicReleaseVersion,
} from "./public-manifest.mjs";
import { createStyle } from "./style.mjs";
import {
  createReleaseUploadPlan,
  makeObjectKey,
} from "./upload-plan.mjs";

export { makeObjectKey };

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const style = createStyle();

function resolveRootPath(...parts) {
  return path.join(rootDir, ...parts);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`命令执行失败：${command} ${args.join(" ")}`);
  }
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: process.env,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`命令执行失败：${command} ${args.join(" ")}`);
  }

  return result.stdout.trim();
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolveRootPath(relativePath), "utf8"));
}

function writeJson(relativePath, value) {
  writeFileSync(resolveRootPath(relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function readPackageVersion() {
  return readJson("package.json").version;
}

function isExactVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+\.\d+)?$/.test(value);
}

function setRootPackageVersion(version) {
  const pkg = readJson("package.json");
  pkg.version = version;
  writeJson("package.json", pkg);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function hashFile(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function removeLegacyGeneratedFiles(layout) {
  for (const fileName of ["public.json", "release.json"]) {
    rmSync(path.join(layout.rootDir, fileName), { force: true });
  }
}

export const DEFAULT_MULTIPART_PART_SIZE = 8 * 1024 * 1024;
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = DEFAULT_MULTIPART_PART_SIZE;

export function createMultipartUploadParts(totalBytes, partSize = DEFAULT_MULTIPART_PART_SIZE) {
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

export function formatUploadBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return unitIndex === 0
    ? `${Math.round(value)} ${units[unitIndex]}`
    : `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatUploadPercent(uploadedBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return "100.0%";
  }

  const percent = Math.min(Math.max(uploadedBytes / totalBytes, 0), 1) * 100;
  return `${percent.toFixed(1)}%`;
}

export function formatUploadProgressLine({
  label,
  filePath,
  bucket,
  key,
  uploadedBytes,
  totalBytes,
}) {
  return `${label} ${filePath} -> s3://${bucket}/${key}  ${formatUploadPercent(uploadedBytes, totalBytes)}  ${formatUploadBytes(uploadedBytes)} / ${formatUploadBytes(totalBytes)}`;
}

function createUploadProgressReporter({ label, filePath, bucket, key, totalBytes }) {
  let lastRenderedAt = 0;
  let lastLoggedBucket = -10;
  let lastLoggedBytes = -1;

  const render = (uploadedBytes, final = false) => {
    const line = formatUploadProgressLine({
      label,
      filePath,
      bucket,
      key,
      uploadedBytes,
      totalBytes,
    });

    if (process.stdout.isTTY) {
      const now = Date.now();
      const isIntermediate = uploadedBytes > 0 && uploadedBytes < totalBytes;

      if (!final && isIntermediate && now - lastRenderedAt < 100) {
        return;
      }

      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      process.stdout.write(line);
      lastRenderedAt = now;

      if (final) {
        process.stdout.write("\n");
      }

      return;
    }

    const percent = totalBytes <= 0
      ? 100
      : Math.floor(Math.min(Math.max(uploadedBytes / totalBytes, 0), 1) * 100);
    const progressBucket = Math.floor(percent / 10) * 10;

    if (final && lastLoggedBytes === uploadedBytes) {
      return;
    }

    if (final || uploadedBytes === 0 || progressBucket >= lastLoggedBucket + 10) {
      console.log(line);
      lastLoggedBucket = progressBucket;
      lastLoggedBytes = uploadedBytes;
    }
  };

  return {
    update(uploadedBytes) {
      render(uploadedBytes, false);
    },
    finish() {
      render(totalBytes, true);
    },
  };
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

export function cacheControlForUpload(upload) {
  return upload.mutable ? "no-cache" : "public, max-age=31536000, immutable";
}

async function putObjectBuffer({ client, PutObjectCommand, bucket, key, filePath, upload, reporter }) {
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: readFileSync(filePath),
    ContentType: contentTypeFor(filePath),
    CacheControl: cacheControlForUpload(upload),
  }));
  reporter.finish();
}

export async function putObjectMultipart({
  client,
  commands,
  bucket,
  key,
  filePath,
  totalBytes,
  upload,
  reporter,
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
    ContentType: contentTypeFor(filePath),
    CacheControl: cacheControlForUpload(upload),
  }));
  const uploadId = createResult.UploadId;

  if (!uploadId) {
    throw new Error(`对象存储没有返回 multipart upload id：${key}`);
  }

  const completedParts = [];
  const fileDescriptor = openSync(filePath, "r");
  let uploadedBytes = 0;
  let completed = false;

  try {
    for (const part of createMultipartUploadParts(totalBytes)) {
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

      uploadedBytes += body.length;
      completedParts.push({
        ETag: result.ETag,
        PartNumber: part.partNumber,
      });
      reporter.update(uploadedBytes);
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
    reporter.finish();
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

function contentTypeFor(filePath) {
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (filePath.endsWith(".sha256") || filePath.endsWith(".md") || filePath.endsWith(".sig")) {
    return "text/plain; charset=utf-8";
  }

  if (filePath.endsWith(".exe") || filePath.endsWith(".msi")) {
    return "application/octet-stream";
  }

  return "application/octet-stream";
}

function releaseEnvAndConfig() {
  const env = loadEnvFile(resolveRootPath(".env.release.local"));
  const config = resolveReleaseConfig({ ...process.env, ...env });
  return { env, config };
}

function resolveSigningPrivateKey(value) {
  if (!value) {
    return value;
  }

  const possiblePath = path.resolve(rootDir, value);

  if (existsSync(possiblePath) && statSync(possiblePath).isFile()) {
    return readFileSync(possiblePath, "utf8");
  }

  return value;
}

function checkVersionConsistency() {
  const version = readPackageVersion();
  const tauri = readJson("src-tauri/tauri.conf.json").version;
  const aiRuntime = readJson("ai-runtime/package.json").version;
  const cargoToml = readFileSync(resolveRootPath("src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = /version\s*=\s*"([^"]+)"/.exec(cargoToml)?.[1];

  const mismatches = [
    ["src-tauri/tauri.conf.json", tauri],
    ["src-tauri/Cargo.toml", cargoVersion],
    ["ai-runtime/package.json", aiRuntime],
  ].filter(([, value]) => value !== version);

  return { version, mismatches };
}

export function createReleaseConfigChecks(config) {
  const requiredConfig = [
    ["TAURI_SIGNING_PRIVATE_KEY", config.signing.privateKey],
    ["RELEASE_PUBLIC_BASE_URL", config.publicBaseUrl],
    ["RELEASE_S3_ENDPOINT", config.s3.endpoint],
    ["RELEASE_S3_BUCKET", config.s3.bucket],
    ["RELEASE_S3_ACCESS_KEY_ID", config.s3.accessKeyId],
    ["RELEASE_S3_SECRET_ACCESS_KEY", config.s3.secretAccessKey],
  ];
  const checks = requiredConfig.map(([name, value]) => {
    const configured = hasReleaseConfigValue(value);

    return {
      level: configured ? "ok" : "error",
      name,
      message: `${name}: ${configured ? "已配置" : "缺失"}`,
    };
  });
  const hasSigningPassword = hasReleaseConfigValue(config.signing.privateKeyPassword);

  checks.splice(1, 0, {
    level: hasSigningPassword ? "ok" : "warn",
    name: "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
    message: hasSigningPassword
      ? "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 已配置"
      : "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 未配置，按无密码私钥处理",
  });

  return checks;
}

export async function doctor() {
  const checks = [];
  const requireTool = (name, args = ["--version"]) => {
    try {
      const value = output(name, args);
      checks.push({ level: "ok", message: `${name}: ${value.split(/\r?\n/)[0]}` });
    } catch (error) {
      checks.push({ level: "error", message: `${name}: ${error.message}` });
    }
  };

  requireTool("git");
  requireTool(bunCommand);
  requireTool(process.platform === "win32" ? "cargo.exe" : "cargo");

  const envPath = resolveRootPath(".env.release.local");
  const hasEnvFile = existsSync(envPath);
  const { config } = releaseEnvAndConfig();
  checks.push({
    level: hasEnvFile ? "ok" : "error",
    message: hasEnvFile ? ".env.release.local: 已找到" : ".env.release.local: 缺失",
  });

  checks.push(...createReleaseConfigChecks(config));

  const { version, mismatches } = checkVersionConsistency();
  checks.push({
    level: mismatches.length === 0 ? "ok" : "error",
    message: mismatches.length === 0
      ? `版本号：全部同步到 ${version}`
      : `版本号：不一致 ${mismatches.map(([file, value]) => `${file}=${value}`).join(", ")}`,
  });

  const changelogPath = resolveRootPath("CHANGELOG.md");
  const hasChangelog = existsSync(changelogPath);
  checks.push({
    level: hasChangelog ? "ok" : "error",
    message: hasChangelog ? "CHANGELOG.md: 已找到" : "CHANGELOG.md: 缺失",
  });

  if (hasChangelog) {
    try {
      extractVersionSection(readFileSync(changelogPath, "utf8"), version);
      checks.push({ level: "ok", message: `CHANGELOG.md: 包含 ${version}` });
    } catch {
      checks.push({ level: "error", message: `CHANGELOG.md: 缺少 ${version}` });
    }
  }

  console.log(style.bold(style.cyan("发布检查")) + "\n");

  for (const check of checks) {
    const label = check.level === "ok"
      ? style.green("通过")
      : check.level === "warn"
        ? style.yellow("警告")
        : style.red("失败");
    console.log(`${label} ${check.message}`);
  }

  console.log(`\n${style.bold("已解析配置摘要")}:`);
  console.log(JSON.stringify(getMaskedConfigSummary(config), null, 2));

  if (checks.some((check) => check.level === "error")) {
    throw new Error("发布检查发现问题。运行 `bun run release help` 查看预期流程。");
  }
}

export function prepare(args) {
  const target = args[0];
  const preidIndex = args.indexOf("--preid");
  const preid = preidIndex >= 0 ? args[preidIndex + 1] : undefined;

  if (!target) {
    throw new Error("用法：bun run release prepare <bump|version> [--preid alpha|beta|rc]");
  }

  const currentVersion = readPackageVersion();
  const nextVersion = isExactVersion(target)
    ? target
    : computeNextVersion(currentVersion, target, preid);

  setRootPackageVersion(nextVersion);
  console.log(`${style.bold("版本号")}: ${currentVersion} -> ${style.green(nextVersion)}`);

  run(bunCommand, ["install", "--lockfile-only"]);
  run(bunCommand, ["scripts/sync-version.js", "--yes"]);

  const changelogPath = resolveRootPath("CHANGELOG.md");

  if (!existsSync(changelogPath)) {
    throw new Error("缺少 CHANGELOG.md。请先创建发布说明源文件。");
  }

  const changelog = readFileSync(changelogPath, "utf8");
  const rotated = rotateUnreleasedSection(changelog, nextVersion, todayIsoDate());
  writeFileSync(changelogPath, rotated);

  console.log(`已将 CHANGELOG.md 轮转到 ${style.green(`v${nextVersion}`)}。`);
}

export function build() {
  const { env } = releaseEnvAndConfig();
  const signingPrivateKey = resolveSigningPrivateKey(
    env.TAURI_SIGNING_PRIVATE_KEY ?? process.env.TAURI_SIGNING_PRIVATE_KEY,
  );
  const signingPassword =
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const tauriSigningEnv = hasReleaseConfigValue(signingPassword)
    ? { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: signingPassword }
    : {};

  if (!hasReleaseConfigValue(signingPrivateKey)) {
    throw new Error("缺少 TAURI_SIGNING_PRIVATE_KEY，请在 .env.release.local 或当前环境变量中配置。");
  }

  run(bunCommand, ["run", "tsc", "--noEmit"]);
  run(bunCommand, ["run", "ai-runtime:typecheck"]);
  run(bunCommand, ["run", "ai-runtime:test"]);
  run(bunCommand, ["run", "tauri", "build"], {
    env: {
      ...process.env,
      ...env,
      TAURI_SIGNING_PRIVATE_KEY: signingPrivateKey,
      ...tauriSigningEnv,
    },
  });
}

export function collect() {
  const version = readPackageVersion();
  const { config } = releaseEnvAndConfig();
  const layout = createReleaseLayout(rootDir, config.outputDir, version);
  const changelog = readFileSync(resolveRootPath("CHANGELOG.md"), "utf8");
  const changelogSection = extractVersionSection(changelog, version);
  const notes = formatUpdaterNotes(changelogSection);
  const discoveredArtifacts = discoverTauriArtifacts(rootDir, version);

  if (discoveredArtifacts.length === 0) {
    throw new Error(`未找到 v${version} 的 Tauri 构建产物。请先运行 \`bun run release build\`。`);
  }

  const copiedArtifacts = copyArtifactsToLayout(discoveredArtifacts, layout)
    .map((artifact) => ({
      ...artifact,
      sha256: hashFile(artifact.destinationPath),
    }));
  const updater = findUpdaterArtifact(copiedArtifacts, config.updater.platform, config.updater.artifact);
  const signature = readFileSync(updater.signature.destinationPath, "utf8").trim();
  const pubDate = changelogSection.date
    ? `${changelogSection.date}T00:00:00Z`
    : new Date().toISOString();
  const latestJson = createLatestJson({
    version,
    notes,
    pubDate,
    publicBaseUrl: config.publicBaseUrl,
    platform: config.updater.platform,
    artifactRelativePath: `${layout.tag}/${updater.artifact.relativePath}`,
    signature,
  });
  const generatedAt = new Date().toISOString();
  const releaseManifest = createReleaseManifest({
    version,
    tag: layout.tag,
    generatedAt,
    artifacts: copiedArtifacts.map((artifact) => ({
      relativePath: artifact.relativePath,
      sha256: artifact.sha256,
      size: artifact.size,
      platform: artifact.platform,
      bundle: artifact.bundle,
      role: artifact.role,
    })),
  });
  const currentPublicVersion = createPublicReleaseVersion({
    versionSection: changelogSection,
    tag: layout.tag,
    publicBaseUrl: config.publicBaseUrl,
    artifacts: releaseManifest.artifacts,
    updaterPlatform: config.updater.platform,
    updaterBundle: config.updater.artifact,
  });
  const publicVersions = extractPublishedVersions(changelog).map((versionSection) => {
    if (versionSection.version === version) {
      return currentPublicVersion;
    }

    return createPublicReleaseVersion({
      versionSection,
      publicBaseUrl: config.publicBaseUrl,
    });
  });
  const publicIndex = createPublicReleaseIndex({
    generatedAt,
    versions: publicVersions,
  });

  mkdirSync(layout.rootDir, { recursive: true });
  removeLegacyGeneratedFiles(layout);
  writeFileSync(layout.notesPath, `${notes}\n`);
  writeFileSync(layout.latestJsonPath, `${JSON.stringify(latestJson, null, 2)}\n`);
  writeFileSync(layout.indexJsonPath, `${JSON.stringify(publicIndex, null, 2)}\n`);
  writeFileSync(layout.checksumsPath, createSha256Manifest(releaseManifest.artifacts));

  console.log(`${style.green("已归档发布产物")}: ${layout.rootDir}`);
  console.log(`${style.bold("Updater 清单")}: ${layout.latestJsonPath}`);
  console.log(`${style.bold("公开发布索引")}: ${layout.indexJsonPath}`);
}

export async function publish(args) {
  const dryRun = args.includes("--dry-run");
  const version = readPackageVersion();
  const { config } = releaseEnvAndConfig();
  const layout = createReleaseLayout(rootDir, config.outputDir, version);

  if (!existsSync(layout.rootDir) || !existsSync(layout.latestJsonPath)) {
    throw new Error(`缺少 ${layout.rootDir}。请先运行 \`bun run release collect\`。`);
  }

  const uploadPlan = createReleaseUploadPlan({ layout, config });

  if (dryRun) {
    console.log(style.bold(style.yellow("发布上传预览")) + "\n");
    for (const upload of uploadPlan.allUploads) {
      console.log(`${style.yellow("预览")} ${upload.filePath} -> s3://${config.s3.bucket}/${upload.key}`);
    }
    return;
  }

  console.log(style.bold(style.cyan("发布上传")) + "\n");

  const {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
  } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    endpoint: config.s3.endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
  });

  try {
    const putAndVerify = async (upload) => {
      const { filePath, key } = upload;
      const totalBytes = statSync(filePath).size;
      const reporter = createUploadProgressReporter({
        label: style.green("上传"),
        filePath,
        bucket: config.s3.bucket,
        key,
        totalBytes,
      });
      reporter.update(0);

      try {
        if (totalBytes > DEFAULT_MULTIPART_THRESHOLD_BYTES) {
          await putObjectMultipart({
            client,
            commands: {
              AbortMultipartUploadCommand,
              CompleteMultipartUploadCommand,
              CreateMultipartUploadCommand,
              UploadPartCommand,
            },
            bucket: config.s3.bucket,
            key,
            filePath,
            totalBytes,
            upload,
            reporter,
          });
        } else {
          await putObjectBuffer({
            client,
            PutObjectCommand,
            bucket: config.s3.bucket,
            key,
            filePath,
            upload,
            reporter,
          });
        }
      } catch (error) {
        if (process.stdout.isTTY) {
          process.stdout.write("\n");
        }
        throw error;
      }

      await client.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    };

    for (const upload of uploadPlan.versionedUploads) {
      await putAndVerify(upload);
    }

    await putAndVerify(uploadPlan.rootIndexUpload);
    await putAndVerify(uploadPlan.rootLatestUpload);
    console.log(`\n${style.green("上传完成")}。公开索引已更新，latest.json 已最后上传。`);
  } finally {
    client.destroy();
  }
}

export function finalize() {
  const version = readPackageVersion();
  const tag = `v${version}`;

  try {
    output("git", ["rev-parse", tag]);
    throw new Error(`Tag 已存在：${tag}`);
  } catch (error) {
    if (!String(error.message).includes("命令执行失败")) {
      throw error;
    }
  }

  const filesToStage = [
    "package.json",
    "bun.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "ai-runtime/package.json",
    "ai-runtime/src/version.ts",
    "CHANGELOG.md",
    ".env.release.example",
    ".gitignore",
    "AGENTS.md",
    "scripts/release.mjs",
    "scripts/release",
  ].filter((file) => existsSync(resolveRootPath(file)));

  run("git", ["add", ...filesToStage]);
  run("git", [
    "commit",
    "-m",
    `chore(release): 发布 v${version}`,
    "-m",
    "- 收敛发布脚本入口并接入 CHANGELOG 更新说明。",
    "-m",
    "- 新增本地发布产物归档、latest.json 生成和 MinIO/S3 上传流程。",
    "-m",
    "- 更新发布指南，记录本地密钥配置与操作顺序。",
  ]);
  run("git", ["tag", "-a", tag, "-m", `发布 ${tag}`]);

  console.log(`\n已创建发布提交和 tag：${style.green(tag)}`);
  console.log("推送命令：");
  console.log(`  ${style.bold("git push --follow-tags")}`);
}
