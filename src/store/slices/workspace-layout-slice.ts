import debounce from "lodash-es/debounce";
import { create } from "zustand";

import { DEFAULT_UI_LAYOUT_STATE } from "@/config/ui-layout";
import {
    STORE_KEY_WORKSPACE_STATE,
    WORKSPACE_STORE_DEFAULTS,
    WORKSPACE_STORE_FILE_NAME,
} from "@/store/constants";
import {
    getStoreValue,
    isTauriEnvironment,
} from "@/store/tauri/store-instances";
import { persistWorkspaceStatePatch } from "@/store/tauri/workspace-state";
import type { UILayoutState, WorkspaceState } from "@/types/ui-layout";

const DEBOUNCE_MS = 500;

async function persistWorkspaceSnapshot(layout: UILayoutState) {
    if (!isTauriEnvironment()) {
        return;
    }
    await persistWorkspaceStatePatch({ layout });
}

const debouncedPersistLayout = debounce((layout: UILayoutState) => {
    void persistWorkspaceSnapshot(layout);
}, DEBOUNCE_MS);

function schedulePersistLayout(layout: UILayoutState) {
    if (!isTauriEnvironment()) {
        return;
    }
    debouncedPersistLayout(layout);
}

/** 导出：工作区布局Store的类型 */
export type WorkspaceLayoutStore = UILayoutState & {
    setLeftSidebarWidth: (width: number) => void;
    setRightSidebarWidth: (width: number) => void;
    setLeftSidebarCollapsed: (collapsed: boolean) => void;
    setRightSidebarCollapsed: (collapsed: boolean) => void;
    toggleLeftSidebar: () => void;
    toggleRightSidebar: () => void;
};

/**
 * 导出：zustand工作区布局store实例
 * 用于管理和持久化UI左/右侧栏的展开收缩和宽度设置
 */
export const useWorkspaceLayoutStore = create<WorkspaceLayoutStore>((set, get) => {
    const snapshot = (): UILayoutState => {
        const s = get();
        return {
            leftSidebarWidth: s.leftSidebarWidth,
            rightSidebarWidth: s.rightSidebarWidth,
            isLeftSidebarCollapsed: s.isLeftSidebarCollapsed,
            isRightSidebarCollapsed: s.isRightSidebarCollapsed,
        };
    };

    return {
        ...DEFAULT_UI_LAYOUT_STATE,
        setLeftSidebarWidth: (leftSidebarWidth) => {
            set({ leftSidebarWidth });
            schedulePersistLayout(snapshot());
        },
        setRightSidebarWidth: (rightSidebarWidth) => {
            set({ rightSidebarWidth });
            schedulePersistLayout(snapshot());
        },
        setLeftSidebarCollapsed: (collapsed: boolean) => {
            set({ isLeftSidebarCollapsed: collapsed });
            schedulePersistLayout(snapshot());
        },
        setRightSidebarCollapsed: (collapsed: boolean) => {
            set({ isRightSidebarCollapsed: collapsed });
            schedulePersistLayout(snapshot());
        },
        toggleLeftSidebar: () => {
            set((s) => ({
                isLeftSidebarCollapsed: !s.isLeftSidebarCollapsed,
            }));
            schedulePersistLayout(snapshot());
        },
        toggleRightSidebar: () => {
            set((s) => ({
                isRightSidebarCollapsed: !s.isRightSidebarCollapsed,
            }));
            schedulePersistLayout(snapshot());
        },
    };
});

/**
 * 导出：异步函数，初始化工作区布局（从存储中读取并设置到zustand store中）
 */
export async function loadInitialWorkspaceLayout(): Promise<void> {
    if (!isTauriEnvironment()) {
        return;
    }
    try {
        let ws = await getStoreValue<WorkspaceState>(
            WORKSPACE_STORE_FILE_NAME,
            STORE_KEY_WORKSPACE_STATE,
            WORKSPACE_STORE_DEFAULTS,
        );
        if (ws?.layout) {
            useWorkspaceLayoutStore.setState({
                ...DEFAULT_UI_LAYOUT_STATE,
                ...ws.layout,
            });
        }
    } catch (e) {
        console.warn("[workspace-layout] loadInitialWorkspaceLayout", e);
    }
}

/**
 * 导出：强制保存当前工作区布局到本地存储（清除防抖，立即持久化）
 */
export async function forceSaveWorkspaceLayout(): Promise<void> {
    debouncedPersistLayout.cancel();
    const s = useWorkspaceLayoutStore.getState();
    await persistWorkspaceSnapshot({
        leftSidebarWidth: s.leftSidebarWidth,
        rightSidebarWidth: s.rightSidebarWidth,
        isLeftSidebarCollapsed: s.isLeftSidebarCollapsed,
        isRightSidebarCollapsed: s.isRightSidebarCollapsed,
    });
}
