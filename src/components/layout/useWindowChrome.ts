import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCurrentWindow, type Window as TauriWindow } from "@tauri-apps/api/window";
import { platform as getPlatform } from "@tauri-apps/plugin-os";

type WindowChromePlatform = "macos" | "windows" | "linux";

const DEFAULT_PLATFORM: WindowChromePlatform = "windows";

/**
 * 仅用于本地开发时预览不同平台的标题栏外观；生产构建始终使用真实平台。
 */
const DEV_PLATFORM_OVERRIDE = import.meta.env.DEV
    ? import.meta.env.VITE_WINDOW_CHROME_PLATFORM
    : undefined;

function normalizePlatform(platformName: string | undefined): WindowChromePlatform {
    return platformName === "macos" || platformName === "windows"
        ? platformName
        : "linux";
}

function isTauriEnvironment() {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function useWindowChrome() {
    const windowRef = useRef<TauriWindow | null>(null);
    const [platform, setPlatform] = useState<WindowChromePlatform>(() =>
        normalizePlatform(DEV_PLATFORM_OVERRIDE ?? DEFAULT_PLATFORM),
    );
    const [isMaximized, setIsMaximized] = useState(false);

    const syncMaximizedState = useCallback(async () => {
        if (!windowRef.current) {
            setIsMaximized(false);
            return;
        }

        try {
            setIsMaximized(await windowRef.current.isMaximized());
        } catch {
            setIsMaximized(false);
        }
    }, []);

    useEffect(() => {
        if (!isTauriEnvironment()) {
            return;
        }

        const currentWindow = getCurrentWindow();
        windowRef.current = currentWindow;

        setPlatform(normalizePlatform(DEV_PLATFORM_OVERRIDE ?? getPlatform()));

        let unlistenResize: (() => void) | undefined;

        void syncMaximizedState();
        void currentWindow.onResized(() => {
            void syncMaximizedState();
        }).then((unlisten) => {
            unlistenResize = unlisten;
        });

        return () => {
            unlistenResize?.();
            windowRef.current = null;
        };
    }, [syncMaximizedState]);

    const minimize = useCallback(async () => {
        await windowRef.current?.minimize();
    }, []);

    const toggleMaximize = useCallback(async () => {
        await windowRef.current?.toggleMaximize();
        await syncMaximizedState();
    }, [syncMaximizedState]);

    const close = useCallback(async () => {
        await windowRef.current?.close();
    }, []);

    const startDragging = useCallback(async () => {
        await windowRef.current?.startDragging();
    }, []);

    const controlsSide = useMemo(
        () => (platform === "macos" ? "left" : "right"),
        [platform],
    );

    return {
        platform,
        controlsSide,
        isMaximized,
        minimize,
        toggleMaximize,
        close,
        startDragging,
    };
}
