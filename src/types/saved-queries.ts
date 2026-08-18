export interface SqlExecutionContext {
    database?: string | null;
    schema?: string | null;
}

export interface SavedQuery {
    id: string;
    profileId: string;
    title: string;
    driver: string;
    databaseName?: string | null;
    schemaName?: string | null;
    sqlText: string;
    createdAt: number;
    updatedAt: number;
    sortOrder?: number | null;
}

export interface CreateSavedQueryInput {
    id: string;
    profileId: string;
    title: string;
    driver: string;
    databaseName?: string | null;
    schemaName?: string | null;
    sqlText: string;
    sortOrder?: number | null;
}

export interface UpdateSavedQueryInput {
    id: string;
    title: string;
    databaseName?: string | null;
    schemaName?: string | null;
    sqlText: string;
    sortOrder?: number | null;
}
