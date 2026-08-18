import type {
  PublicReleaseDownload,
  PublicReleaseIndex,
  PublicReleaseVersion,
} from "./types";

const platformOrder: Record<string, number> = {
  "windows-x86_64": 10,
  "windows-aarch64": 11,
  "darwin-aarch64": 20,
  "darwin-x86_64": 21,
  "linux-x86_64": 30,
  "linux-aarch64": 31,
};

const bundleOrder: Record<string, number> = {
  nsis: 10,
  msi: 20,
  dmg: 30,
  appimage: 40,
  deb: 50,
  rpm: 60,
};

function orderValue(values: Record<string, number>, key: string): number {
  return values[key] ?? 999;
}

export function sortReleaseDownloads(downloads: PublicReleaseDownload[]): PublicReleaseDownload[] {
  return [...downloads].sort((left, right) => {
    if (left.recommended !== right.recommended) {
      return left.recommended ? -1 : 1;
    }

    const platformDiff = orderValue(platformOrder, left.platform) - orderValue(platformOrder, right.platform);

    if (platformDiff !== 0) {
      return platformDiff;
    }

    const bundleDiff = orderValue(bundleOrder, left.bundle) - orderValue(bundleOrder, right.bundle);

    if (bundleDiff !== 0) {
      return bundleDiff;
    }

    return left.label.localeCompare(right.label, "zh-CN");
  });
}

export async function resolveReleaseDownloads(
  version: PublicReleaseVersion,
  loadVersionIndex: (url: string) => Promise<PublicReleaseIndex | null>,
): Promise<PublicReleaseDownload[]> {
  const directDownloads = version.downloads ?? [];

  if (directDownloads.length > 0) {
    return sortReleaseDownloads(directDownloads);
  }

  const versionIndexUrl = version.links?.versionIndex;

  if (!versionIndexUrl) {
    return [];
  }

  try {
    const versionIndex = await loadVersionIndex(versionIndexUrl);
    const hydratedVersion = versionIndex?.versions.find((candidate) => {
      return candidate.version === version.version || candidate.tag === version.tag;
    });

    return sortReleaseDownloads(hydratedVersion?.downloads ?? []);
  } catch {
    return [];
  }
}
