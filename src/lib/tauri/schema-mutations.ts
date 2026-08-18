import { apiInvoke } from "@/lib/api-client";
import type {
    CreateDatabaseInput,
    CreateDatabaseResult,
    DatabaseCharacterSet,
    DropDatabaseInput,
    DropDatabaseResult,
    DropTableInput,
    DropTableResult,
    SchemaMutationPreview,
    UpdateDatabaseInput,
    UpdateDatabaseResult,
    ContainerRef,
} from "@/types/ipc";

export function previewCreateDatabase(
    profileId: string,
    input: CreateDatabaseInput,
): Promise<SchemaMutationPreview> {
    return apiInvoke<SchemaMutationPreview>("preview_create_database", {
        profileId,
        input,
    });
}

export function createDatabase(
    profileId: string,
    input: CreateDatabaseInput,
): Promise<CreateDatabaseResult> {
    return apiInvoke<CreateDatabaseResult>("create_database", {
        profileId,
        input,
    });
}

export function previewUpdateDatabase(
    profileId: string,
    input: UpdateDatabaseInput,
): Promise<SchemaMutationPreview> {
    return apiInvoke<SchemaMutationPreview>("preview_update_database", {
        profileId,
        input,
    });
}

export function updateDatabase(
    profileId: string,
    input: UpdateDatabaseInput,
): Promise<UpdateDatabaseResult> {
    return apiInvoke<UpdateDatabaseResult>("update_database", {
        profileId,
        input,
    });
}

export function previewDropDatabase(
    profileId: string,
    input: DropDatabaseInput,
): Promise<SchemaMutationPreview> {
    return apiInvoke<SchemaMutationPreview>("preview_drop_database", {
        profileId,
        input,
    });
}

export function dropDatabase(
    profileId: string,
    input: DropDatabaseInput,
): Promise<DropDatabaseResult> {
    return apiInvoke<DropDatabaseResult>("drop_database", {
        profileId,
        input,
    });
}

export function previewDropTable(
    profileId: string,
    input: DropTableInput,
): Promise<SchemaMutationPreview> {
    return apiInvoke<SchemaMutationPreview>("preview_drop_table", {
        profileId,
        input,
    });
}

export function dropTable(
    profileId: string,
    input: DropTableInput,
): Promise<DropTableResult> {
    return apiInvoke<DropTableResult>("drop_table", {
        profileId,
        input,
    });
}

export function listMysqlCharacterSets(
    profileId: string,
): Promise<DatabaseCharacterSet[]> {
    return apiInvoke<DatabaseCharacterSet[]>("list_mysql_character_sets", {
        profileId,
    });
}

export function getMysqlDatabaseCharacterSet(
    profileId: string,
    container: ContainerRef,
): Promise<string | null> {
    return apiInvoke<string | null>("get_mysql_database_character_set", {
        profileId,
        container,
    });
}
