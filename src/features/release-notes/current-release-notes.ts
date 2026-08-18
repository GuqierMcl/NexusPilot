import { invoke } from "@tauri-apps/api/core";

export interface CurrentReleaseNotes {
    version: string;
    body: string;
    source: "cache" | "remote";
    fetchedAt?: number | null;
}

export async function getCurrentReleaseNotes(): Promise<CurrentReleaseNotes> {
    return invoke<CurrentReleaseNotes>("get_current_release_notes");
}
