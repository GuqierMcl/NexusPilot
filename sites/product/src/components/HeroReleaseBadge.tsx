import { useEffect, useState } from "react";

import { loadPublicReleaseIndex } from "../shared/release-registry/client";
import { formatVersion } from "../shared/release-registry/format";

type HeroReleaseBadgeState =
  | { status: "loading" }
  | { status: "ready"; version: string }
  | { status: "error" };

const badgeClassName =
  "relative rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-xs text-zinc-500 sm:ml-2";

export function HeroReleaseBadge() {
  const [state, setState] = useState<HeroReleaseBadgeState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;

    async function loadLatestVersion() {
      try {
        const index = await loadPublicReleaseIndex();
        const version = index.latest?.version ?? index.versions[0]?.version;

        if (!version) {
          throw new Error("发布索引中没有可展示版本。");
        }

        if (!cancelled) {
          setState({ status: "ready", version });
        }
      } catch {
        if (!cancelled) {
          setState({ status: "error" });
        }
      }
    }

    void loadLatestVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "error") {
    return <span className={badgeClassName}>获取失败</span>;
  }

  if (state.status === "loading") {
    return (
      <span
        aria-label="正在获取最新版本"
        className={`${badgeClassName} inline-flex h-6 w-14 animate-pulse`}
      />
    );
  }

  return <span className={badgeClassName}>{formatVersion(state.version)}</span>;
}
