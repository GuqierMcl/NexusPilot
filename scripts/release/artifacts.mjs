import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function resolveReleaseVersionDir(rootDir, outputDir, version) {
  return path.join(rootDir, outputDir, `v${version}`);
}

export function createReleaseLayout(rootDir, outputDir, version) {
  const registryRootDir = path.join(rootDir, outputDir);
  const releaseRoot = resolveReleaseVersionDir(rootDir, outputDir, version);

  return {
    version,
    tag: `v${version}`,
    registryRootDir,
    rootDir: releaseRoot,
    platformDirs: {
      windows: path.join(releaseRoot, "windows-x86_64"),
      macosAarch64: path.join(releaseRoot, "darwin-aarch64"),
      macosX64: path.join(releaseRoot, "darwin-x86_64"),
      linuxX64: path.join(releaseRoot, "linux-x86_64"),
    },
    logsDir: path.join(releaseRoot, "logs"),
    notesPath: path.join(releaseRoot, "notes.md"),
    indexJsonPath: path.join(releaseRoot, "index.json"),
    latestJsonPath: path.join(releaseRoot, "latest.json"),
    checksumsPath: path.join(releaseRoot, "checksums.sha256"),
  };
}

export function classifyTauriArtifact(fileName, version) {
  if (fileName === `NexusPilot_${version}_x64-setup.exe`) {
    return { platform: "windows-x86_64", bundle: "nsis", role: "installer" };
  }

  if (fileName === `NexusPilot_${version}_x64-setup.exe.sig`) {
    return { platform: "windows-x86_64", bundle: "nsis", role: "signature" };
  }

  if (fileName === `NexusPilot_${version}_x64_en-US.msi`) {
    return { platform: "windows-x86_64", bundle: "msi", role: "installer" };
  }

  if (fileName === `NexusPilot_${version}_x64_en-US.msi.sig`) {
    return { platform: "windows-x86_64", bundle: "msi", role: "signature" };
  }

  return null;
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const entries = [];

  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, item.name);

    if (item.isDirectory()) {
      entries.push(...listFilesRecursive(fullPath));
    } else if (item.isFile()) {
      entries.push(fullPath);
    }
  }

  return entries;
}

export function discoverTauriArtifacts(rootDir, version) {
  const bundleDir = path.join(rootDir, "src-tauri", "target", "release", "bundle");

  return listFilesRecursive(bundleDir)
    .map((sourcePath) => {
      const classification = classifyTauriArtifact(path.basename(sourcePath), version);

      if (!classification) {
        return undefined;
      }

      return {
        sourcePath,
        fileName: path.basename(sourcePath),
        ...classification,
      };
    })
    .filter(Boolean);
}

export function copyArtifactsToLayout(artifacts, layout) {
  mkdirSync(layout.rootDir, { recursive: true });
  mkdirSync(layout.platformDirs.windows, { recursive: true });
  mkdirSync(layout.logsDir, { recursive: true });

  return artifacts.map((artifact) => {
    const destinationDir = artifact.platform === "windows-x86_64"
      ? layout.platformDirs.windows
      : path.join(layout.rootDir, artifact.platform);
    const destinationPath = path.join(destinationDir, artifact.fileName);

    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(artifact.sourcePath, destinationPath);

    return {
      ...artifact,
      destinationPath,
      relativePath: path.relative(layout.rootDir, destinationPath).replace(/\\/g, "/"),
      size: statSync(destinationPath).size,
    };
  });
}

export function findUpdaterArtifact(copiedArtifacts, platform, bundle) {
  const artifact = copiedArtifacts.find(
    (item) => item.platform === platform && item.bundle === bundle && item.role === "installer",
  );
  const signature = copiedArtifacts.find(
    (item) => item.platform === platform && item.bundle === bundle && item.role === "signature",
  );

  if (!artifact || !signature) {
    throw new Error(`缺少 ${platform}/${bundle} 对应的 updater 产物或签名文件。`);
  }

  return { artifact, signature };
}
