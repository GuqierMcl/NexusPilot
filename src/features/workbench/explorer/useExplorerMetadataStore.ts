import { create, type StateCreator } from "zustand";

import { apiInvoke } from "@/lib/api-client";
import { buildRemoteNodes } from "@/features/workbench/explorer/buildRemoteNodes";
import type { ExplorerTreeNode } from "@/features/workbench/explorer/types";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
import {
    canLoadRemoteMetadata,
    decideConnectionMetadataAction,
} from "@/store/slices/connection-runtime-state";
import type { ContainerRef, DataContainer } from "@/types/ipc";

export interface ExplorerMetadataStore {
    loadedChildren: Record<string, ExplorerTreeNode[]>;
    loadingKeys: Set<string>;
    errorKeys: Record<string, string>;
    loadChildren: (node: ExplorerTreeNode) => Promise<void>;
    reloadChildren: (node: ExplorerTreeNode) => Promise<void>;
    clearForProfile: (profileId: string) => void;
}

export type ExplorerContainerLoader = (
    profileId: string,
    parent: ContainerRef | null,
) => Promise<DataContainer[]>;

function ownsProfileKey(key: string, profileId: string): boolean {
    return key === profileId || key.startsWith(`${profileId}::`);
}

function buildExplorerMetadataState(
    loader: ExplorerContainerLoader,
): StateCreator<ExplorerMetadataStore> {
    return (set, get) => ({
        loadedChildren: {},
        loadingKeys: new Set(),
        errorKeys: {},

        loadChildren: async (node) => {
            await loadNodeChildren(node, get, set, loader, false);
        },

        reloadChildren: async (node) => {
            await loadNodeChildren(node, get, set, loader, true);
        },

        clearForProfile: (profileId) => {
            set((state) => {
                const nextLoaded: Record<string, ExplorerTreeNode[]> = {};
                const nextErrors: Record<string, string> = {};
                const nextLoading = new Set(state.loadingKeys);

                for (const key of Object.keys(state.loadedChildren)) {
                    if (!ownsProfileKey(key, profileId)) {
                        nextLoaded[key] = state.loadedChildren[key]!;
                    }
                }
                for (const key of Object.keys(state.errorKeys)) {
                    if (!ownsProfileKey(key, profileId)) {
                        nextErrors[key] = state.errorKeys[key]!;
                    }
                }
                for (const key of state.loadingKeys) {
                    if (ownsProfileKey(key, profileId)) {
                        nextLoading.delete(key);
                    }
                }

                return {
                    loadedChildren: nextLoaded,
                    errorKeys: nextErrors,
                    loadingKeys: nextLoading,
                };
            });
        },
    });
}

export function createExplorerMetadataStore(loader: ExplorerContainerLoader) {
    return create<ExplorerMetadataStore>(buildExplorerMetadataState(loader));
}

const invokeContainerLoader: ExplorerContainerLoader = (profileId, parent) =>
    apiInvoke<DataContainer[]>(
        "list_containers",
        { profileId, parent },
        { silent: true },
    );

export const useExplorerMetadataStore = createExplorerMetadataStore(
    invokeContainerLoader,
);

async function loadNodeChildren(
    node: ExplorerTreeNode,
    get: () => ExplorerMetadataStore,
    set: (
        partial:
            | Partial<ExplorerMetadataStore>
            | ((state: ExplorerMetadataStore) => Partial<ExplorerMetadataStore>),
    ) => void,
    loader: ExplorerContainerLoader,
    force: boolean,
) {
    const { loadedChildren, loadingKeys } = get();
    const key = node.id;

    if (loadingKeys.has(key) || (!force && key in loadedChildren)) {
        return;
    }

    if ("isLeaf" in node && node.isLeaf) {
        return;
    }

    set((state) => {
        const { [key]: _removed, ...restErrors } = state.errorKeys;
        return {
            loadingKeys: new Set([...state.loadingKeys, key]),
            errorKeys: restErrors,
        };
    });

    try {
        let children: ExplorerTreeNode[] = [];

        if (node.type === "connection") {
            const profileId = node.id;
            let session =
                useConnectionSessionStore.getState().sessions[profileId];
            let action = decideConnectionMetadataAction(session);
            if (action === "connect") {
                await useConnectionSessionStore.getState().connect(profileId);
                session =
                    useConnectionSessionStore.getState().sessions[profileId];
                action = decideConnectionMetadataAction(session);
            }

            if (action === "wait") {
                finishLoadingWithoutReplacingChildren(set, key);
                return;
            }

            if (action === "connect") {
                throw new Error(session?.errorMsg ?? "连接失败");
            }

            if (action === "load") {
                const containers = await loader(profileId, null);
                children = buildRemoteNodes(profileId, containers);
            }
        } else if ("metadata" in node && node.metadata.container) {
            const { profileId, container } = node.metadata;
            const session =
                useConnectionSessionStore.getState().sessions[profileId];
            if (!canLoadRemoteMetadata(session)) {
                finishLoadingWithoutReplacingChildren(set, key);
                return;
            }
            const containers = await loader(profileId, container);
            children = buildRemoteNodes(profileId, containers);
        }

        set((state) => {
            const nextLoading = new Set(state.loadingKeys);
            nextLoading.delete(key);
            const { [key]: _removed, ...restErrors } = state.errorKeys;
            return {
                loadedChildren: { ...state.loadedChildren, [key]: children },
                loadingKeys: nextLoading,
                errorKeys: restErrors,
            };
        });
    } catch (error) {
        const message =
            error != null &&
            typeof error === "object" &&
            "message" in error
                ? String((error as { message: unknown }).message)
                : "加载失败";

        set((state) => {
            const nextLoading = new Set(state.loadingKeys);
            nextLoading.delete(key);
            return {
                loadingKeys: nextLoading,
                errorKeys: { ...state.errorKeys, [key]: message },
            };
        });
    }
}

function finishLoadingWithoutReplacingChildren(
    set: (
        partial:
            | Partial<ExplorerMetadataStore>
            | ((state: ExplorerMetadataStore) => Partial<ExplorerMetadataStore>),
    ) => void,
    key: string,
): void {
    set((state) => {
        const nextLoading = new Set(state.loadingKeys);
        nextLoading.delete(key);
        const { [key]: _removed, ...restErrors } = state.errorKeys;
        return {
            loadingKeys: nextLoading,
            errorKeys: restErrors,
        };
    });
}
