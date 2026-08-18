import { useCallback } from "react";

import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { toast } from "@/components/ui/toast";

import { useUpdateStore } from "@/store/slices/update-slice";

import {
    downloadUpdate,
    fetchAvailableUpdate,
    installDownloadedUpdate,
    prepareForUpdateInstall,
    type UpdateCheckMode,
} from "./update-service";
import { createDevelopmentMockUpdate } from "./development-mock-update";

let lastStartupToastVersion: string | null = null;

export function useUpdateController() {
    const availableUpdate = useUpdateStore((state) => state.availableUpdate);
    const availableUpdateInfo = useUpdateStore(
        (state) => state.availableUpdateInfo,
    );
    const isCheckingUpdate = useUpdateStore((state) => state.isCheckingUpdate);
    const isInstallingUpdate = useUpdateStore(
        (state) => state.isInstallingUpdate,
    );
    const isUpdateDialogOpen = useUpdateStore(
        (state) => state.isUpdateDialogOpen,
    );
    const lastCheckedAt = useUpdateStore((state) => state.lastCheckedAt);
    const lastError = useUpdateStore((state) => state.lastError);
    const replaceAvailableUpdate = useUpdateStore(
        (state) => state.replaceAvailableUpdate,
    );
    const setIsCheckingUpdate = useUpdateStore(
        (state) => state.setIsCheckingUpdate,
    );
    const setIsInstallingUpdate = useUpdateStore(
        (state) => state.setIsInstallingUpdate,
    );
    const setUpdateDialogOpen = useUpdateStore(
        (state) => state.setUpdateDialogOpen,
    );
    const setLastCheckedAt = useUpdateStore((state) => state.setLastCheckedAt);
    const setLastError = useUpdateStore((state) => state.setLastError);

    const openUpdateDialog = useCallback(() => {
        setUpdateDialogOpen(true);
    }, [setUpdateDialogOpen]);

    const closeUpdateDialog = useCallback(() => {
        if (isInstallingUpdate) {
            return;
        }

        setUpdateDialogOpen(false);
    }, [isInstallingUpdate, setUpdateDialogOpen]);

    const checkForUpdates = useCallback(
        async (mode: UpdateCheckMode): Promise<void> => {
            if (!import.meta.env.PROD && mode === "startup") {
                return;
            }

            setIsCheckingUpdate(true);
            setLastError(null);

            try {
                const update = !import.meta.env.PROD
                    ? createDevelopmentMockUpdate()
                    : await fetchAvailableUpdate(mode);
                await replaceAvailableUpdate(update);

                if (!update) {
                    if (mode === "manual") {
                        toast.success("当前已是最新版本");
                    }

                    return;
                }

                if (mode === "manual") {
                    setUpdateDialogOpen(true);
                    return;
                }

                if (lastStartupToastVersion === update.version) {
                    return;
                }

                lastStartupToastVersion = update.version;
                toast.info(`发现新版本 ${update.version}`, {
                    description: `当前版本 ${update.currentVersion}，点击查看完整更新日志并确认安装。`,
                    action: {
                        label: "查看",
                        onClick: () => {
                            setUpdateDialogOpen(true);
                        },
                    },
                });
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "检查更新失败";
                setLastError(message);
                console.error("[update] check failed:", error);

                if (mode === "manual") {
                    toast.error(message);
                }
            } finally {
                setLastCheckedAt(Date.now());
                setIsCheckingUpdate(false);
            }
        },
        [
            replaceAvailableUpdate,
            setIsCheckingUpdate,
            setLastCheckedAt,
            setLastError,
            setUpdateDialogOpen,
        ],
    );

    const installCurrentUpdate = useCallback(
        async (onEvent?: (event: DownloadEvent) => void): Promise<void> => {
            if (!import.meta.env.PROD) {
                toast.info("开发环境模拟更新不会下载安装。");
                return;
            }

            const update = useUpdateStore.getState().availableUpdate;

            if (!update) {
                toast.error("当前没有可安装的更新");
                return;
            }

            setIsInstallingUpdate(true);
            setLastError(null);

            try {
                await downloadUpdate(update, onEvent);
                await prepareForUpdateInstall();
                await installDownloadedUpdate(update);
                await replaceAvailableUpdate(null);
                setUpdateDialogOpen(false);
                toast.success("已安装新版本，正在重启应用…");
                await relaunch();
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : "安装更新失败";
                setLastError(message);
                console.error("[update] install failed:", error);
                toast.error(message);
            } finally {
                setIsInstallingUpdate(false);
            }
        },
        [
            replaceAvailableUpdate,
            setIsInstallingUpdate,
            setLastError,
            setUpdateDialogOpen,
        ],
    );

    return {
        availableUpdate,
        availableUpdateInfo,
        isCheckingUpdate,
        isInstallingUpdate,
        isUpdateDialogOpen,
        lastCheckedAt,
        lastError,
        checkForUpdates,
        closeUpdateDialog,
        installCurrentUpdate,
        openUpdateDialog,
    };
}
