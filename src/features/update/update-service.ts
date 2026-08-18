import {
    check,
    type CheckOptions,
    type DownloadOptions,
    type DownloadEvent,
    type Update,
} from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";

export type UpdateCheckMode = "startup" | "manual";

export interface UpdateCheckOptions
    extends Omit<CheckOptions, "timeout"> {
    timeoutMs?: number;
}

let activeUpdateCheck: Promise<Update | null> | null = null;

function getDefaultTimeout(mode: UpdateCheckMode): number {
    return mode === "startup" ? 5_000 : 10_000;
}

export async function fetchAvailableUpdate(
    mode: UpdateCheckMode,
    options: UpdateCheckOptions = {},
): Promise<Update | null> {
    if (activeUpdateCheck) {
        return activeUpdateCheck;
    }

    const timeout = options.timeoutMs ?? getDefaultTimeout(mode);
    activeUpdateCheck = check({
        headers: options.headers,
        timeout,
        proxy: options.proxy,
        target: options.target,
        allowDowngrades: options.allowDowngrades,
    });

    try {
        return await activeUpdateCheck;
    } finally {
        activeUpdateCheck = null;
    }
}

export async function downloadUpdate(
    update: Update,
    onEvent?: (event: DownloadEvent) => void,
    options?: DownloadOptions,
): Promise<void> {
    await update.download(onEvent, options);
}

export async function prepareForUpdateInstall(): Promise<void> {
    await invoke("shutdown_ai_runtime_sidecar");
}

export async function installDownloadedUpdate(update: Update): Promise<void> {
    await update.install();
}
