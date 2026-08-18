import {
    DEFAULT_UI_LAYOUT_STATE,
    DEFAULT_WORKSPACE_EXPLORER_STATE,
    DEFAULT_WORKSPACE_STATE,
} from "@/config/ui-layout";
import {
    STORE_KEY_WORKSPACE_STATE,
    WORKSPACE_STORE_DEFAULTS,
    WORKSPACE_STORE_FILE_NAME,
} from "@/store/constants";
import {
    getStoreValue,
    isTauriEnvironment,
    saveStore,
    setStoreValue,
} from "@/store/tauri/store-instances";
import type { WorkspaceState } from "@/types/ui-layout";

let workspaceStateWriteQueue = Promise.resolve();

export function persistWorkspaceStatePatch(
    patch: Partial<WorkspaceState>,
): Promise<void> {
    if (!isTauriEnvironment()) {
        return Promise.resolve();
    }

    const nextWrite = workspaceStateWriteQueue.catch(() => undefined).then(async () => {
        const existing = await getStoreValue<WorkspaceState>(
            WORKSPACE_STORE_FILE_NAME,
            STORE_KEY_WORKSPACE_STATE,
            WORKSPACE_STORE_DEFAULTS,
        );
        const payload: WorkspaceState = {
            ...DEFAULT_WORKSPACE_STATE,
            ...existing,
            ...patch,
            layout: {
                ...DEFAULT_UI_LAYOUT_STATE,
                ...existing?.layout,
                ...(patch.layout ?? {}),
            },
            explorer: {
                ...DEFAULT_WORKSPACE_EXPLORER_STATE,
                ...existing?.explorer,
                ...(patch.explorer ?? {}),
            },
        };

        await setStoreValue(
            WORKSPACE_STORE_FILE_NAME,
            STORE_KEY_WORKSPACE_STATE,
            payload,
            WORKSPACE_STORE_DEFAULTS,
        );
        await saveStore(WORKSPACE_STORE_FILE_NAME, WORKSPACE_STORE_DEFAULTS);
    });

    workspaceStateWriteQueue = nextWrite;
    return nextWrite;
}
