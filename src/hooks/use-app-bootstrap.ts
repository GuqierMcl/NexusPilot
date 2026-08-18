import { useEffect, useState } from "react";

import { runStoreBootstrap } from "@/store/bootstrap";

/**
 * 应用启动时执行的异步逻辑（仅一次）。
 * 等待 Zustand 设置水合与工作区布局从 Tauri Store 加载完成后再放行 UI（水坝）。
 */
export function useAppBootstrap() {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<unknown>(undefined);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                await runStoreBootstrap();
            } catch (e) {
                if (!cancelled) {
                    setError(e);
                    console.error("[app-bootstrap]", e);
                }
            } finally {
                if (!cancelled) {
                    setReady(true);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, []);

    return { ready, error };
}
