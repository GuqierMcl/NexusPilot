import { useEffect, useState } from "react";
import { Download, FileText, ShieldCheck } from "lucide-react";

import {
  loadPublicReleaseIndex,
  loadPublicReleaseIndexFromUrl,
} from "../../shared/release-registry/client";
import { resolveReleaseDownloads, sortReleaseDownloads } from "../../shared/release-registry/downloads";
import {
  formatBundleLabel,
  formatFileSize,
  formatPlatformLabel,
  formatReleaseDate,
  formatVersion,
} from "../../shared/release-registry/format";
import type { PublicReleaseVersion } from "../../shared/release-registry/types";

type DownloadPanelState =
  | { status: "loading" }
  | {
      status: "ready";
      latestVersion: PublicReleaseVersion;
    }
  | { status: "error" };

export function DownloadPanel() {
  const [state, setState] = useState<DownloadPanelState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadReleaseData() {
      try {
        const index = await loadPublicReleaseIndex();
        const latestVersion = index.latest
          ? index.versions.find((version) => version.version === index.latest?.version)
          : index.versions[0];

        if (!latestVersion) {
          throw new Error("发布索引中没有可展示版本。");
        }

        const downloads = await resolveReleaseDownloads(latestVersion, loadPublicReleaseIndexFromUrl);

        if (cancelled) {
          return;
        }

        setState({ status: "ready", latestVersion: { ...latestVersion, downloads } });
      } catch {
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    }

    void loadReleaseData();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className="max-w-2xl rounded-lg border border-white/[0.08] bg-white/[0.02] p-5">
        <p className="font-mono text-xs text-zinc-500">CURRENT RELEASE</p>
        <div className="mt-3 h-6 w-36 rounded bg-white/[0.08]" aria-hidden="true" />
        <p className="mt-3 text-sm text-zinc-400">正在获取最新版本...</p>
        <span className="mt-4 inline-flex rounded-md border border-white/[0.06] px-4 py-2 text-sm text-zinc-600">
          获取中
        </span>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="max-w-2xl rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-5">
        <p className="font-mono text-xs text-amber-400/80">CURRENT RELEASE</p>
        <h3 className="mt-2 text-lg font-semibold text-white">暂时无法获取最新版本</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-400">请稍后刷新页面再试。</p>
      </div>
    );
  }

  const { latestVersion } = state;
  const downloadOptions = sortReleaseDownloads(latestVersion.downloads ?? []);

  return (
    <div className="max-w-2xl">
      <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.04] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="font-mono text-xs text-zinc-500">LATEST VERSION</p>
            <h3 className="mt-1 text-xl font-semibold text-white">{formatVersion(latestVersion.version)}</h3>
            <p className="mt-1 text-sm text-zinc-500">{formatReleaseDate(latestVersion.pubDate)}</p>
            <p className="download-panel-hint mt-3 max-w-md text-xs leading-5 text-zinc-500">
              首次安装或覆盖升级请选择对应下载项，完整记录可在发布日志中查看。
            </p>
          </div>

          {downloadOptions.length > 0 ? (
            <div className="grid shrink-0 gap-2 sm:min-w-56">
              {downloadOptions.map((download) => {
                const isRecommended = download.recommended;

                return (
                  <a
                    key={`${download.platform}-${download.bundle}-${download.url}`}
                    href={download.url}
                    className={
                      isRecommended
                        ? "grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 rounded-md px-5 py-2 text-sm font-medium text-white transition-all hover:opacity-90"
                        : "grid grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-3 rounded-md border border-white/[0.08] px-5 py-2 text-sm font-medium text-zinc-200 transition-all hover:border-white/20 hover:text-white"
                    }
                    style={isRecommended ? { background: "var(--brand-gradient)" } : undefined}
                  >
                    <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 text-left">
                      <span className="block">下载 {formatPlatformLabel(download.platform)}</span>
                      <span className={isRecommended ? "block text-xs text-white/70" : "block text-xs text-zinc-500"}>
                        {formatBundleLabel(download.bundle)}
                        {download.size ? ` · ${formatFileSize(download.size)}` : ""}
                      </span>
                    </span>
                  </a>
                );
              })}
            </div>
          ) : (
            <span className="inline-flex shrink-0 items-center rounded-md border border-white/[0.06] px-4 py-2 text-sm text-zinc-600">
              暂无可下载产物
            </span>
          )}
        </div>

        {downloadOptions.some((download) => download.signatureUrl) ? (
          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-500">
            {downloadOptions.map((download) => (
              download.signatureUrl ? (
                <a
                  key={`${download.bundle}-${download.signatureUrl}`}
                  href={download.signatureUrl}
                  className="inline-flex items-center gap-1 hover:text-white"
                >
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatBundleLabel(download.bundle)} 签名
                </a>
              ) : null
            ))}
          </div>
        ) : null}

        <div className="mt-5 border-t border-white/[0.06] pt-4">
          <a href="/releases" className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white">
            <FileText className="h-4 w-4" aria-hidden="true" />
            查看发布日志
          </a>
        </div>
      </div>
    </div>
  );
}
