import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import {
  loadPublicReleaseIndex,
  loadPublicReleaseIndexFromUrl,
  loadReleaseNotes,
} from "../release-registry/client";
import { resolveReleaseDownloads } from "../release-registry/downloads";
import {
  formatBundleLabel,
  formatFileSize,
  formatPlatformLabel,
  formatReleaseDate,
  formatVersion,
} from "../release-registry/format";
import type { PublicReleaseDownload, PublicReleaseVersion } from "../release-registry/types";

interface ReleaseHistoryProps {
  mode?: "website" | "docs";
}

interface ReleaseHistoryEntry extends PublicReleaseVersion {
  markdown?: string;
}

type ReleaseHistoryState =
  | { status: "loading" }
  | { status: "ready"; versions: ReleaseHistoryEntry[] }
  | { status: "error" };

function renderMarkdownNotes(markdown: string, mode: "website" | "docs") {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Array<
    | { type: "heading"; text: string }
    | { type: "paragraph"; text: string }
    | { type: "list"; items: string[] }
  > = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      blocks.push({ type: "list", items: listItems });
      listItems = [];
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      return;
    }

    if (trimmed.startsWith("- ")) {
      listItems.push(trimmed.slice(2));
      return;
    }

    flushList();

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    const nextContentLine = lines.slice(index + 1).find((nextLine) => nextLine.trim().length > 0)?.trim();
    const looksLikeSectionHeading = Boolean(nextContentLine?.startsWith("- ")) && !trimmed.endsWith("：");

    blocks.push({
      type: heading || looksLikeSectionHeading ? "heading" : "paragraph",
      text: heading?.[2] ?? trimmed,
    });
  });

  flushList();

  return (
    <div className={mode === "website" ? "mt-4 space-y-4" : "mt-4 space-y-3"}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <h3
              key={`heading-${index}`}
              className={mode === "website" ? "text-sm font-medium text-zinc-200" : "text-base font-semibold"}
            >
              {block.text}
            </h3>
          );
        }

        if (block.type === "list") {
          return (
            <ul
              key={`list-${index}`}
              className={
                mode === "website"
                  ? "list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-400"
                  : "list-disc space-y-1 pl-5 text-sm"
              }
            >
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }

        return (
          <p
            key={`paragraph-${index}`}
            className={mode === "website" ? "text-sm leading-6 text-zinc-400" : "text-sm leading-6"}
          >
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function DownloadLinks({ downloads }: { downloads: PublicReleaseDownload[] }) {
  if (downloads.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {downloads.map((download) => (
        <a
          key={`${download.platform}-${download.bundle}-${download.url}`}
          href={download.url}
          className="inline-flex items-center gap-2 rounded-md border border-white/[0.08] px-3 py-1.5 text-sm text-zinc-200 hover:text-white"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>{formatPlatformLabel(download.platform)}</span>
          <span className="font-medium text-zinc-100">{formatBundleLabel(download.bundle)}</span>
          {download.size ? <span className="text-zinc-500">{formatFileSize(download.size)}</span> : null}
        </a>
      ))}
    </div>
  );
}

async function hydrateReleaseVersion(version: PublicReleaseVersion): Promise<ReleaseHistoryEntry> {
  const [markdown, downloads] = await Promise.all([
    version.notesUrl ? loadReleaseNotes(version.notesUrl) : null,
    resolveReleaseDownloads(version, loadPublicReleaseIndexFromUrl),
  ]);

  return {
    ...version,
    downloads,
    markdown: markdown ?? version.releaseNotes?.body,
  };
}

export function ReleaseHistory({ mode = "website" }: ReleaseHistoryProps) {
  const [state, setState] = useState<ReleaseHistoryState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadReleaseHistory() {
      try {
        const index = await loadPublicReleaseIndex();
        const versions = await Promise.all(index.versions.map(hydrateReleaseVersion));

        if (!cancelled) {
          setState({ status: "ready", versions });
        }
      } catch {
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    }

    void loadReleaseHistory();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div
        className={
          mode === "website"
            ? "rounded-lg border border-white/[0.08] bg-white/[0.02] p-5 text-sm text-zinc-400"
            : "not-prose rounded-lg border border-slate-200 p-5 text-sm dark:border-slate-800"
        }
      >
        正在获取发布日志...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        className={
          mode === "website"
            ? "rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-5 text-sm text-zinc-300"
            : "not-prose rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
        }
      >
        暂时无法获取发布日志，请稍后刷新。
      </div>
    );
  }

  return (
    <div className={mode === "website" ? "space-y-6" : "space-y-5"}>
      {state.versions.map((version) => (
        <article
          key={version.version}
          className={
            mode === "website"
              ? "rounded-lg border border-white/[0.08] bg-white/[0.02] p-5"
              : "not-prose rounded-lg border border-slate-200 p-5 dark:border-slate-800"
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className={mode === "website" ? "text-xl font-semibold text-white" : "text-xl font-semibold"}>
                {formatVersion(version.version)}
              </h2>
              <p className={mode === "website" ? "text-sm text-zinc-500" : "text-sm text-slate-500"}>
                {formatReleaseDate(version.pubDate)}
              </p>
            </div>

          </div>

          {mode === "website" ? <DownloadLinks downloads={version.downloads ?? []} /> : null}

          {version.markdown ? renderMarkdownNotes(version.markdown, mode) : (
            <p className={mode === "website" ? "mt-4 text-sm text-zinc-500" : "mt-4 text-sm text-slate-500"}>
              此版本发布日志暂时不可用。
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
