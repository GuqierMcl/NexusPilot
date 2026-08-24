import { releaseRegistry } from "../config/releases";
import type { PublicReleaseIndex } from "./types";

export const releaseIndexUrl = releaseRegistry.indexUrl;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPublicReleaseIndex(value: unknown): value is PublicReleaseIndex {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.product === "NexusPilot"
    && value.channel === "stable"
    && Array.isArray(value.versions);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-cache" });

  if (!response.ok) {
    throw new Error(`读取发布数据失败：${response.status}`);
  }

  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-cache" });

  if (!response.ok) {
    throw new Error(`读取发布文本失败：${response.status}`);
  }

  return response.text();
}

export async function loadPublicReleaseIndexFromUrl(url: string): Promise<PublicReleaseIndex> {
  const value = await fetchJson(url);

  if (!isPublicReleaseIndex(value)) {
    throw new Error("发布索引数据格式不可识别。");
  }

  return value;
}

export async function loadPublicReleaseIndex(): Promise<PublicReleaseIndex> {
  return loadPublicReleaseIndexFromUrl(releaseIndexUrl);
}

export async function loadReleaseNotes(url: string): Promise<string | null> {
  try {
    return await fetchText(url);
  } catch {
    return null;
  }
}
