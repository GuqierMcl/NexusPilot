export function formatVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export function formatReleaseDate(value?: string): string {
  if (!value) {
    return "发布日期未记录";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return index === 0 ? `${Math.round(value)} ${units[index]}` : `${value.toFixed(1)} ${units[index]}`;
}

export function formatPlatformLabel(platform: string): string {
  const labels: Record<string, string> = {
    "windows-x86_64": "Windows x64",
    "windows-aarch64": "Windows ARM64",
    "darwin-aarch64": "macOS Apple Silicon",
    "darwin-x86_64": "macOS Intel",
    "linux-aarch64": "Linux ARM64",
    "linux-x86_64": "Linux x64",
  };

  return labels[platform] ?? platform;
}

export function formatBundleLabel(bundle: string): string {
  const labels: Record<string, string> = {
    nsis: "EXE",
    msi: "MSI",
    dmg: "DMG",
    appimage: "AppImage",
    deb: "DEB",
    rpm: "RPM",
  };

  return labels[bundle] ?? bundle;
}
