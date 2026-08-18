import {
  createPublicReleaseSummary,
  toPublicChangelogSections,
} from "./changelog.mjs";
import { normalizePublicUrl } from "./manifest.mjs";

const product = "NexusPilot";
const channel = "stable";

const downloadLabels = new Map([
  ["windows-x86_64/nsis", "Windows 安装包"],
  ["windows-x86_64/msi", "Windows MSI 安装包"],
]);

function createReleaseUrl(publicBaseUrl, tag, relativePath) {
  return normalizePublicUrl(publicBaseUrl, `${tag}/${relativePath}`);
}

function createDownloadLabel(artifact) {
  return downloadLabels.get(`${artifact.platform}/${artifact.bundle}`)
    ?? `${artifact.platform} ${artifact.bundle}`;
}

function createRecommendedDownloadUrl(downloads) {
  return downloads.find((download) => download.recommended)?.url ?? downloads[0]?.url;
}

export function createPublicDownloads({
  publicBaseUrl,
  tag,
  artifacts = [],
  updaterPlatform,
  updaterBundle,
}) {
  return artifacts
    .filter((artifact) => artifact.role === "installer")
    .map((artifact) => {
      const signature = artifacts.find(
        (candidate) =>
          candidate.role === "signature"
          && candidate.platform === artifact.platform
          && candidate.bundle === artifact.bundle,
      );
      const download = {
        platform: artifact.platform,
        bundle: artifact.bundle,
        label: createDownloadLabel(artifact),
        url: createReleaseUrl(publicBaseUrl, tag, artifact.relativePath),
        sha256: artifact.sha256,
        size: artifact.size,
        recommended: artifact.platform === updaterPlatform && artifact.bundle === updaterBundle,
      };

      if (signature) {
        download.signatureUrl = createReleaseUrl(publicBaseUrl, tag, signature.relativePath);
      }

      return download;
    });
}

export function createPublicReleaseVersion({
  versionSection,
  tag = `v${versionSection.version}`,
  publicBaseUrl,
  artifacts = [],
  updaterPlatform,
  updaterBundle,
}) {
  const sections = toPublicChangelogSections(versionSection.sections);
  const downloads = createPublicDownloads({
    publicBaseUrl,
    tag,
    artifacts,
    updaterPlatform,
    updaterBundle,
  });
  const recommendedDownloadUrl = createRecommendedDownloadUrl(downloads);
  const version = {
    version: versionSection.version,
    tag,
    pubDate: versionSection.date ? `${versionSection.date}T00:00:00Z` : undefined,
    summary: createPublicReleaseSummary(versionSection),
    sections,
    notesUrl: normalizePublicUrl(publicBaseUrl, `${tag}/notes.md`),
    downloads,
    links: {
      checksums: normalizePublicUrl(publicBaseUrl, `${tag}/checksums.sha256`),
      versionIndex: normalizePublicUrl(publicBaseUrl, `${tag}/index.json`),
      versionUpdaterManifest: normalizePublicUrl(publicBaseUrl, `${tag}/latest.json`),
    },
  };

  if (recommendedDownloadUrl) {
    version.recommendedDownloadUrl = recommendedDownloadUrl;
  }

  return version;
}

export function createPublicReleaseIndex({ generatedAt, versions }) {
  const latest = versions[0];

  return {
    schemaVersion: 1,
    product,
    channel,
    generatedAt,
    latest: latest
      ? {
          version: latest.version,
          tag: latest.tag,
        }
      : undefined,
    versions,
  };
}
