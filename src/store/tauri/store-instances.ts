import { load, type Store, type StoreOptions } from "@tauri-apps/plugin-store";

import {
    SETTINGS_LOAD_DEFAULTS,
    SETTINGS_STORE_FILE_NAME,
    WORKSPACE_LOAD_DEFAULTS,
    WORKSPACE_STORE_FILE_NAME,
} from "@/store/constants";

export type { Store, StoreOptions };

const storePromises = new Map<string, Promise<Store>>();

export function isTauriEnvironment(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getStore(
    fileName: string,
    options: StoreOptions,
): Promise<Store> {
    if (!isTauriEnvironment()) {
        throw new Error("Tauri Store is only available in the desktop app");
    }

    const cached = storePromises.get(fileName);
    if (cached) {
        return cached;
    }

    const promise = load(fileName, options);
    storePromises.set(fileName, promise);
    return promise;
}

export function releaseStore(fileName: string): void {
    storePromises.delete(fileName);
}

export async function getSettingsStore(): Promise<Store> {
    return getStore(SETTINGS_STORE_FILE_NAME, {
        autoSave: true,
        defaults: SETTINGS_LOAD_DEFAULTS,
    });
}

export async function getWorkspaceStore(): Promise<Store> {
    return getStore(WORKSPACE_STORE_FILE_NAME, {
        autoSave: true,
        defaults: WORKSPACE_LOAD_DEFAULTS,
    });
}

export async function getStoreValue<T>(
    fileName: string,
    key: string,
    defaults: Record<string, unknown>,
): Promise<T | undefined> {
    try {
        const store = await getStore(fileName, {
            autoSave: true,
            defaults,
        });
        return await store.get<T>(key);
    } catch (e) {
        console.warn(`[Store] getStoreValue failed: ${key}`, e);
        return undefined;
    }
}

export async function setStoreValue<T>(
    fileName: string,
    key: string,
    value: T,
    defaults: Record<string, unknown>,
): Promise<void> {
    try {
        const store = await getStore(fileName, {
            autoSave: true,
            defaults,
        });
        await store.set(key, value);
    } catch (e) {
        console.error(`[Store] setStoreValue failed: ${key}`, e);
    }
}

export async function saveStore(
    fileName: string,
    defaults: Record<string, unknown>,
): Promise<void> {
    try {
        const store = await getStore(fileName, {
            autoSave: true,
            defaults,
        });
        await store.save();
    } catch (e) {
        console.error("[Store] saveStore failed", e);
    }
}
