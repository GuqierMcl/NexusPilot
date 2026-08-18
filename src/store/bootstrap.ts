import { getAiRuntimeEndpoint } from "@/lib/ai-runtime/endpoint";
import { applyInterfaceFontFamily } from "@/lib/appearance";
import { useSettingsStore } from "@/store/slices/settings-slice";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";
import { initializeAuthSession } from "@/store/slices/auth-session-slice";
import { loadInitialExplorerState } from "@/store/slices/explorer-slice";
import { loadInitialWorkspaceLayout } from "@/store/slices/workspace-layout-slice";

const THEME_STORAGE_KEY = "vite-ui-theme";

/**
 * 启动阶段：依次完成 store 水合、主题同步、工作区布局加载、AI Runtime endpoint 获取。
 * 在 React 挂载前调用，确保全局状态就绪后再渲染 UI。
 */
export async function runStoreBootstrap(): Promise<void> {
    // 账号登录是可选能力；初始化内部会隔离所有失败，且不持久化 WebView 状态。
    await initializeAuthSession();

    try {
        await useSettingsStore.persist.rehydrate();
    } catch (e) {
        console.warn("[bootstrap] settings rehydrate:", e);
    }

    const { themeMode, interfaceFontFamilyInput } =
        useSettingsStore.getState().common;
    try {
        localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
        /* private mode */
    }

    applyInterfaceFontFamily(interfaceFontFamilyInput);

    try {
        await Promise.all([
            loadInitialWorkspaceLayout(),
            loadInitialExplorerState(),
        ]);
    } catch (e) {
        console.warn("[bootstrap] workspace state:", e);
    }

    // 通过 IPC 获取 AI Runtime endpoint（host/port/mode/base_url），写入全局 store。
    try {
        const endpoint = await getAiRuntimeEndpoint();
        useAiRuntimeEndpointStore.getState().setEndpoint(endpoint);
    } catch (e) {
        console.error("[bootstrap] ai-runtime endpoint:", e);
    }
}
