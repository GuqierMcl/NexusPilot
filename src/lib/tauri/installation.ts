import { invoke } from "@tauri-apps/api/core";

import type { InstallationIdentity } from "@/types/ipc";

export async function getInstallationIdentity(): Promise<InstallationIdentity> {
    return await invoke<InstallationIdentity>("get_installation_identity");
}
