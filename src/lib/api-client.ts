import { invoke } from "@tauri-apps/api/core";
import { toast } from "@/components/ui/toast";

import {
    publishRuntimeFailure,
    toRuntimeFailureEvent,
} from "@/lib/connection-runtime-events";
import { getIpcErrorToastMessage, normalizeIpcError } from "@/lib/ipc-error";

// ─── 调用参数选项 ──────────────────────────────────────────────────────────────

export interface ApiInvokeOptions {
    /**
     * 若为 `true`，则不自动弹出 `toast.error` 错误通知。
     * 当调用方自行处理错误展示时使用。
     */
    silent?: boolean;
    /** 设为 false 时，本次调用失败不发布运行时健康事件。 */
    trackRuntimeHealth?: boolean;
}

// ─── 核心拦截器 ───────────────────────────────────────────────────────────────

/**
 * 所有 connection-engine IPC 调用的统一 invoke 封装。
 *
 * - 将原始 Tauri 错误转换为强类型 `IAppError` 对象。
 * - 统一分发 `toast.error` 错误提示（除非传入 `silent: true`）。
 * - DEV 开发环境下输出详细信息到控制台。
 * - 始终抛出 `IAppError`，调用方可通过 `error.code` 分支处理。
 *
 * **不要用于本地存储 CRUD**（`connection_commands`、`connection_folder_commands`）。
 * 这些命令请用 `src/lib/tauri/connections.ts` 提供的专用方法。
 */
export async function apiInvoke<T>(
    command: string,
    args?: Record<string, unknown>,
    options: ApiInvokeOptions = {},
): Promise<T> {
    try {
        return await invoke<T>(command, args);
    } catch (raw) {
        const appError = normalizeIpcError(raw);

        if (options.trackRuntimeHealth !== false) {
            const runtimeFailure = toRuntimeFailureEvent(
                command,
                args,
                appError,
                Date.now(),
            );
            if (runtimeFailure) {
                publishRuntimeFailure(runtimeFailure);
            }
        }

        if (import.meta.env.DEV) {
            console.error(`[apiInvoke] ${command} 调用失败`, {
                code: appError.code,
                message: appError.message,
                details: appError.details,
            });
        }

        if (!options.silent && appError.code !== "OPERATION_CANCELED") {
            toast.error(getIpcErrorToastMessage(appError));
        }

        throw appError;
    }
}
