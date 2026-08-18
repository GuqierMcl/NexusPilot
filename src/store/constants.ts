import type { AppSettings } from "@/types/settings";
import type { WorkspaceState } from "@/types/ui-layout";
import { DEFAULT_APP_SETTINGS } from "@/config/app-settings";
import { DEFAULT_WORKSPACE_STATE } from "@/config/ui-layout";

/** 应用设置/偏好 Store 文件名 */
export const SETTINGS_STORE_FILE_NAME = "nexus_pilot_settings.json";

/** 工作区状态 Store 文件名 */
export const WORKSPACE_STORE_FILE_NAME = "nexus_pilot_workspace.json";

/** AppSettings 在 Tauri Store 中的键名（与历史 persistence-config 一致） */
export const STORE_KEY_APP_SETTINGS = "appSettings" as const;

/** WorkspaceState 在 Tauri Store 中的键名 */
export const STORE_KEY_WORKSPACE_STATE = "workspaceState" as const;

export const SETTINGS_STORE_DEFAULTS: Record<string, AppSettings> = {
    [STORE_KEY_APP_SETTINGS]: DEFAULT_APP_SETTINGS,
};

export const WORKSPACE_STORE_DEFAULTS: Record<string, WorkspaceState> = {
    [STORE_KEY_WORKSPACE_STATE]: DEFAULT_WORKSPACE_STATE,
};

/** `load()` 选项用：与 plugin-store 的 defaults 形状一致 */
export const SETTINGS_LOAD_DEFAULTS: Record<string, AppSettings> = SETTINGS_STORE_DEFAULTS;
export const WORKSPACE_LOAD_DEFAULTS: Record<string, WorkspaceState> = WORKSPACE_STORE_DEFAULTS;
