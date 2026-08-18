export type PlatformStatus = "available" | "planned" | "hidden";

export interface DownloadPlatform {
  id: "windows" | "macos" | "linux";
  label: string;
  architecture?: string;
  status: PlatformStatus;
  version?: string;
  href?: string;
  fileType?: string;
  checksum?: string;
  note?: string;
}

export interface CurrentRelease {
  version: string;
  releaseDate: string;
  notesHref: string;
  platforms: DownloadPlatform[];
}

export interface ReleaseRegistryConfig {
  publicBaseUrl: string;
  indexUrl: string;
}

const releasePublicBaseUrl = "https://dl.nexuspilot.dev/releases";

export const releaseRegistry: ReleaseRegistryConfig = {
  publicBaseUrl: releasePublicBaseUrl,
  indexUrl: `${releasePublicBaseUrl}/index.json`,
};

export const currentRelease: CurrentRelease = {
  version: "0.3.0",
  releaseDate: "2026-06-29",
  notesHref: "/docs/releases",
  platforms: [
    {
      id: "windows",
      label: "Windows",
      architecture: "x64",
      status: "available",
      version: "0.3.0",
      href: "https://dl.nexuspilot.dev/oss/releases/NexusPilot_0.3.0_x64-setup.exe",
      fileType: "setup.exe",
      note: "当前推荐下载版本",
    },
    {
      id: "macos",
      label: "macOS",
      status: "planned",
      note: "计划支持",
    },
    {
      id: "linux",
      label: "Linux",
      status: "planned",
      note: "计划支持",
    },
  ],
};

export const availableDownloads = currentRelease.platforms.filter(
  (platform) => platform.status === "available",
);

export const visibleDownloadPlatforms = currentRelease.platforms.filter(
  (platform) => platform.status !== "hidden",
);
