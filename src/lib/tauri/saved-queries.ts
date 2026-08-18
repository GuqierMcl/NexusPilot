import { invoke } from "@tauri-apps/api/core";

import type {
    CreateSavedQueryInput,
    SavedQuery,
    UpdateSavedQueryInput,
} from "@/types/saved-queries";

export async function listSavedQueries(profileId: string): Promise<SavedQuery[]> {
    return await invoke<SavedQuery[]>("list_saved_queries", { profileId });
}

export async function getSavedQuery(id: string): Promise<SavedQuery | null> {
    return await invoke<SavedQuery | null>("get_saved_query", { id });
}

export async function createSavedQuery(
    input: CreateSavedQueryInput,
): Promise<SavedQuery> {
    return await invoke<SavedQuery>("create_saved_query", { input });
}

export async function updateSavedQuery(
    input: UpdateSavedQueryInput,
): Promise<SavedQuery> {
    return await invoke<SavedQuery>("update_saved_query", { input });
}

export async function deleteSavedQuery(id: string): Promise<boolean> {
    return await invoke<boolean>("delete_saved_query", { id });
}
