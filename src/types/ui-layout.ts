/**
 * UI 布局状态类型定义，用于 WorkspaceState。
 * 后续可在此扩展：panelSizes, recentFiles, openTabs, etc.
 */

/** 侧边栏布局状态 */
export type UILayoutState = {
    /** 左侧边栏宽度百分比 (0-100) */
    leftSidebarWidth: number;
    /** 右侧边栏宽度百分比 (0-100) */
    rightSidebarWidth: number;
    /** 左侧边栏是否折叠 */
    isLeftSidebarCollapsed: boolean;
    /** 右侧边栏是否折叠 */
    isRightSidebarCollapsed: boolean;
};

/** 工作区状态完整类型 */
export type WorkspaceState = {
    /** UI 布局状态 */
    layout: UILayoutState;
    /** Explorer 这类工作区 UI 偏好状态 */
    explorer?: WorkspaceExplorerState;
};

/** Explorer UI 偏好状态 */
export type WorkspaceExplorerState = {
    /** 已展开的 Explorer 节点 id */
    expandedNodeIds: string[];
    /** 是否已经由用户交互初始化过展开状态 */
    expansionStateInitialized?: boolean;
};

/** Zustand persist 存储的完整 payload */
export type WorkspaceStateStorage = {
    state: UILayoutState;
    version: number;
};
