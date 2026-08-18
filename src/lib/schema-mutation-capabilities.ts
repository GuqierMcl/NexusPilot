import type {
    ContainerKind,
    DriverCapabilities,
    SchemaMutationOperation,
} from "@/types/ipc";

export function supportsSchemaMutation(
    capabilities: DriverCapabilities | null | undefined,
    kind: ContainerKind,
    operation: SchemaMutationOperation,
): boolean {
    return (
        capabilities?.schemaMutation?.objects.some(
            (object) =>
                object.kind === kind && object.operations.includes(operation),
        ) ?? false
    );
}
