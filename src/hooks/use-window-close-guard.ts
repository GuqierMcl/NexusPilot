import { useEffect, useRef } from "react";

import {
    getCurrentWindow,
    type CloseRequestedEvent,
} from "@tauri-apps/api/window";

import { forceSaveExplorerState } from "@/store/slices/explorer-slice";
import { forceSaveWorkspaceLayout } from "@/store/slices/workspace-layout-slice";
import { isTauriEnvironment } from "@/store/tauri/store-instances";

export type { CloseRequestedEvent };

export type WindowCloseGuardHandler = (
    event: CloseRequestedEvent,
) => void | Promise<void>;

function useCloseRequestedSubscription(
    getHandler: () => WindowCloseGuardHandler,
) {
    const getHandlerRef = useRef(getHandler);
    getHandlerRef.current = getHandler;

    useEffect(() => {
        if (!isTauriEnvironment()) {
            return;
        }

        let disposed = false;
        let unlisten: (() => void) | undefined;

        void (async () => {
            try {
                unlisten = await getCurrentWindow().onCloseRequested(
                    async (event) => {
                        /**
                         * Tauri 2：此回调若 reject，将不会执行 destroy，窗口会关不掉。
                         * 因此必须吞掉业务 handler 的异常，仍走默认关闭流程。
                         */
                        try {
                            await getHandlerRef.current()(event);
                        } catch (err) {
                            console.error("[window-close-guard] handler error", err);
                        }
                    },
                );
            } catch (err) {
                console.error("[window-close-guard] register failed", err);
                return;
            }

            if (disposed) {
                unlisten();
            }
        })();

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);
}

/**
 * 窗口即将关闭时调用（用户点关闭、Alt+F4、`close()` 等都会触发）。
 * 需要**取消关闭**时调用 `event.preventDefault()`（例如未保存提示）。
 * 用户确认关闭后不要调用 `preventDefault`，窗口会正常关闭。
 */
export async function completeWindowClose(): Promise<void> {
    if (!isTauriEnvironment()) return;

    try {
        // 保存工作区布局与资源树状态。
        await Promise.all([
            forceSaveWorkspaceLayout(),
            forceSaveExplorerState(),
        ]);
    } catch (err) {
        console.error("[window-close-guard] force save workspace state", err);
    }
    try {
        await getCurrentWindow().destroy();
    } catch (err) {
        console.error("[window-close-guard] destroy", err);
    }
}

export async function runWindowCloseGuard(
    event: CloseRequestedEvent,
): Promise<void> {
    if (!isTauriEnvironment()) {
        return;
    }
    event.preventDefault();
    await completeWindowClose();
}

/**
 * 注册当前 Webview 对应窗口的关闭拦截逻辑，在应用根组件调用一次即可。
 *
 * 实际逻辑写在 {@link runWindowCloseGuard}；若需依赖 React Context，
 * 可使用 {@link useWindowCloseGuardWithHandler} 并传入回调。
 */
export function useWindowCloseGuard() {
    useCloseRequestedSubscription(() => runWindowCloseGuard);
}

/**
 * 与 {@link useWindowCloseGuard} 相同，但使用可变的 `handler`（便于读取 Context / props）。
 */
export function useWindowCloseGuardWithHandler(handler: WindowCloseGuardHandler) {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;
    useCloseRequestedSubscription(() => handlerRef.current);
}
