import { create } from "zustand";

import type { Update } from "@tauri-apps/plugin-updater";

export interface AvailableUpdateInfo {
    currentVersion: string;
    version: string;
    date?: string;
    body?: string;
    rawJson: Record<string, unknown>;
}

export interface UpdateState {
    availableUpdate: Update | null;
    availableUpdateInfo: AvailableUpdateInfo | null;
    isCheckingUpdate: boolean;
    isInstallingUpdate: boolean;
    isUpdateDialogOpen: boolean;
    lastCheckedAt: number | null;
    lastError: string | null;
    replaceAvailableUpdate: (update: Update | null) => Promise<void>;
    setIsCheckingUpdate: (isCheckingUpdate: boolean) => void;
    setIsInstallingUpdate: (isInstallingUpdate: boolean) => void;
    setUpdateDialogOpen: (isOpen: boolean) => void;
    setLastCheckedAt: (checkedAt: number | null) => void;
    setLastError: (errorMessage: string | null) => void;
}

function toAvailableUpdateInfo(update: Update): AvailableUpdateInfo {
    return {
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body,
        rawJson: update.rawJson,
    };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
    availableUpdate: null,
    availableUpdateInfo: null,
    isCheckingUpdate: false,
    isInstallingUpdate: false,
    isUpdateDialogOpen: false,
    lastCheckedAt: null,
    lastError: null,
    replaceAvailableUpdate: async (update) => {
        const currentUpdate = get().availableUpdate;

        if (currentUpdate && currentUpdate !== update) {
            try {
                await currentUpdate.close();
            } catch (error) {
                console.error("[update-store] close available update:", error);
            }
        }

        set((state) => ({
            ...state,
            availableUpdate: update,
            availableUpdateInfo: update ? toAvailableUpdateInfo(update) : null,
            isUpdateDialogOpen: update ? state.isUpdateDialogOpen : false,
        }));
    },
    setIsCheckingUpdate: (isCheckingUpdate) => set({ isCheckingUpdate }),
    setIsInstallingUpdate: (isInstallingUpdate) =>
        set({ isInstallingUpdate }),
    setUpdateDialogOpen: (isUpdateDialogOpen) => set({ isUpdateDialogOpen }),
    setLastCheckedAt: (lastCheckedAt) => set({ lastCheckedAt }),
    setLastError: (lastError) => set({ lastError }),
}));
