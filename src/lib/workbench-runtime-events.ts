import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
    ConnectionRuntimeChangedEvent,
    ConnectionRuntimeSnapshot,
} from "@/types/ipc";

export const CONNECTION_RUNTIME_CHANGED_EVENT =
    "connection-runtime-changed";

export function listenToConnectionRuntimeChanges(
    handler: (event: ConnectionRuntimeChangedEvent) => void,
): Promise<UnlistenFn> {
    return listen<ConnectionRuntimeChangedEvent>(
        CONNECTION_RUNTIME_CHANGED_EVENT,
        (event) => handler(event.payload),
    );
}

export function listConnectionRuntimeSnapshots(): Promise<
    ConnectionRuntimeSnapshot[]
> {
    return invoke<ConnectionRuntimeSnapshot[]>(
        "list_connection_runtime_snapshots",
    );
}
