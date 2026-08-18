export function normalizePublicUrl(baseUrl, relativePath) {
  return `${baseUrl.replace(/\/+$/g, "")}/${relativePath.replace(/^\/+/g, "")}`;
}

export function createLatestJson({
  version,
  notes,
  pubDate,
  publicBaseUrl,
  platform,
  artifactRelativePath,
  signature,
}) {
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      [platform]: {
        signature,
        url: normalizePublicUrl(publicBaseUrl, artifactRelativePath),
      },
    },
  };
}

export function createReleaseManifest({ version, tag, generatedAt, artifacts }) {
  return {
    version,
    tag,
    generatedAt,
    artifacts,
  };
}

export function createSha256Manifest(artifacts) {
  return artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.relativePath}`)
    .join("\n") + (artifacts.length > 0 ? "\n" : "");
}
