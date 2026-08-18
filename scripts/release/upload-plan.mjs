import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function makeObjectKey(...parts) {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/g, "");
}

export function listFilesRecursive(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      entries.push(fullPath);
    }
  }

  return entries;
}

function createVersionedUpload(layout, config, filePath) {
  const relative = path.relative(layout.rootDir, filePath).replace(/\\/g, "/");

  return {
    filePath,
    key: makeObjectKey(config.s3.prefix, layout.tag, relative),
    mutable: false,
  };
}

function isLegacyGeneratedManifest(filePath) {
  const name = path.basename(filePath);

  return name === "public.json" || name === "release.json";
}

export function createReleaseUploadPlan({
  layout,
  config,
  versionedFiles = listFilesRecursive(layout.rootDir),
}) {
  const versionedUploads = versionedFiles
    .filter((filePath) => !isLegacyGeneratedManifest(filePath))
    .map((filePath) => createVersionedUpload(layout, config, filePath));
  const rootIndexUpload = {
    filePath: layout.indexJsonPath,
    key: makeObjectKey(config.s3.prefix, "index.json"),
    mutable: true,
  };
  const rootLatestUpload = {
    filePath: layout.latestJsonPath,
    key: makeObjectKey(config.s3.prefix, "latest.json"),
    mutable: true,
  };

  return {
    versionedUploads,
    rootIndexUpload,
    rootLatestUpload,
    allUploads: [
      ...versionedUploads,
      rootIndexUpload,
      rootLatestUpload,
    ],
  };
}
