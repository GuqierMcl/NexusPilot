import { useEffect } from "react";

import { clearProfileQueryCache } from "@/features/workbench/explorer/profile-query-cache";
import { useExplorerMetadataStore } from "@/features/workbench/explorer/useExplorerMetadataStore";
import { queryClient } from "@/lib/query-client";
import {
    listConnectionRuntimeSnapshots,
    listenToConnectionRuntimeChanges,
} from "@/lib/workbench-runtime-events";
import { useConnectionSessionStore } from "@/store/slices/connection-session-slice";
import { useWorkbenchTabsStore } from "@/store/slices/workbench-tabs-slice";
import type { ConnectionRuntimeChangedEvent } from "@/types/ipc";

function clearDisconnectedProfile(profileId: string): void {
    useWorkbenchTabsStore.getState().closeTabsByProfileId(profileId);
    useExplorerMetadataStore.getState().clearForProfile(profileId);
    void clearProfileQueryCache(queryClient, profileId);
}

export function WorkbenchRuntimeProjection() {
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;
        let reconciling = false;
        const pendingEvents: ConnectionRuntimeChangedEvent[] = [];

        const applyEvent = (event: ConnectionRuntimeChangedEvent): void => {
            useConnectionSessionStore.getState().applyRuntimeChanged(event);
            if (event.kind === "removed") {
                clearDisconnectedProfile(event.profileId);
            }
        };

        const reconcile = async (): Promise<void> => {
            if (disposed || reconciling) return;
            reconciling = true;
            try {
                const snapshots = await listConnectionRuntimeSnapshots();
                if (disposed) return;
                const removed = useConnectionSessionStore
                    .getState()
                    .reconcileRuntimeSnapshots(snapshots);
                for (const profileId of removed) {
                    clearDisconnectedProfile(profileId);
                }
            } catch (error: unknown) {
                console.error(
                    "[workbench-runtime] snapshot reconciliation failed",
                    error,
                );
            } finally {
                reconciling = false;
                if (!disposed) {
                    for (const event of pendingEvents.splice(0)) {
                        applyEvent(event);
                    }
                }
            }
        };

        void (async () => {
            unlisten = await listenToConnectionRuntimeChanges((event) => {
                if (disposed) return;
                if (reconciling) {
                    pendingEvents.push(event);
                } else {
                    applyEvent(event);
                }
            });
            if (disposed) {
                unlisten();
                return;
            }
            window.addEventListener("focus", reconcile);
            await reconcile();
        })().catch((error: unknown) => {
            console.error(
                "[workbench-runtime] projection initialization failed",
                error,
            );
        });

        return () => {
            disposed = true;
            window.removeEventListener("focus", reconcile);
            unlisten?.();
        };
    }, []);

    return null;
}
