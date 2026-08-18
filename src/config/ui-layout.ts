import type {
    UILayoutState,
    WorkspaceExplorerState,
    WorkspaceState,
} from "@/types/ui-layout";

/** 默认 UI 布局状态 */
export const DEFAULT_UI_LAYOUT_STATE: UILayoutState = {
    leftSidebarWidth: 30,
    rightSidebarWidth: 30,
    isLeftSidebarCollapsed: false,
    isRightSidebarCollapsed: false,
};

/** 默认 Explorer UI 偏好状态 */
export const DEFAULT_WORKSPACE_EXPLORER_STATE: WorkspaceExplorerState = {
    expandedNodeIds: [],
    expansionStateInitialized: false,
};

/** 默认工作区状态 */
export const DEFAULT_WORKSPACE_STATE: WorkspaceState = {
    layout: DEFAULT_UI_LAYOUT_STATE,
    explorer: DEFAULT_WORKSPACE_EXPLORER_STATE,
};
