export type PublicReleaseSectionType =
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security"
  | string;

export interface PublicReleaseSection {
  type: PublicReleaseSectionType;
  title: string;
  emoji: string;
  items: string[];
}

export interface PublicReleaseDownload {
  platform: string;
  bundle: string;
  label: string;
  url: string;
  signatureUrl?: string;
  sha256: string;
  size: number;
  recommended: boolean;
}

export interface PublicReleaseVersion {
  version: string;
  tag: string;
  pubDate?: string;
  summary?: string;
  sections: PublicReleaseSection[];
  notesUrl?: string;
  recommendedDownloadUrl?: string;
  downloads?: PublicReleaseDownload[];
  releaseNotes?: {
    format: "markdown";
    body: string;
  };
  links?: {
    checksums?: string;
    versionIndex?: string;
    versionUpdaterManifest?: string;
  };
}

export interface PublicReleaseIndex {
  schemaVersion: 1;
  product: "NexusPilot";
  channel: "stable";
  generatedAt: string;
  latest?: {
    version: string;
    tag: string;
  };
  versions: PublicReleaseVersion[];
}
