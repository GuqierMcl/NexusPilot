import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AuthSessionSnapshot } from "@/types/ipc";

export const AUTH_SESSION_CHANGED_EVENT = "auth-session-changed";

export function listenToAuthSessionChanges(
    handler: (snapshot: AuthSessionSnapshot) => void,
): Promise<UnlistenFn> {
    return listen<AuthSessionSnapshot>(AUTH_SESSION_CHANGED_EVENT, (event) => {
        handler(event.payload);
    });
}
