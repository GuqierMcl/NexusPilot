import type { StateStorage } from "zustand/middleware";

import {
    getSettingsStore,
    isTauriEnvironment,
} from "@/store/tauri/store-instances";

/**
 * Zustand `persist` 的异步存储：与 tauri-plugin-store 桥接。
 * `setItem` 必须先 `JSON.parse` 再 `store.set`，避免 JSON 被二次转义成字符串。
 */
export function createTauriSettingsPersistStorage(): StateStorage {
    return {
        getItem: async (name: string) => {
            if (!isTauriEnvironment()) {
                return null;
            }
            try {
                const store = await getSettingsStore();
                const value = await store.get<unknown>(name);
                if (value == null) {
                    return null;
                }
                return JSON.stringify(value);
            } catch {
                return null;
            }
        },
        setItem: async (name: string, value: string) => {
            if (!isTauriEnvironment()) {
                return;
            }
            try {
                const store = await getSettingsStore();
                const parsed: unknown = JSON.parse(value);
                await store.set(name, parsed);
                await store.save();
            } catch (e) {
                console.error("[persist] setItem failed", e);
            }
        },
        removeItem: async (name: string) => {
            if (!isTauriEnvironment()) {
                return;
            }
            try {
                const store = await getSettingsStore();
                await store.delete(name);
                await store.save();
            } catch (e) {
                console.error("[persist] removeItem failed", e);
            }
        },
    };
}
