import { apiInvoke, type ApiInvokeOptions } from "@/lib/api-client";
import type {
    ClickHouseViewChangeResult,
    ClickHouseViewChangeTarget,
    ClickHouseViewCreateResult,
    ClickHouseViewCreateTarget,
    ClickHouseViewDescribeRequest,
    ClickHouseViewFamily,
    ClickHouseViewRuntimeSupport,
    ClickHouseViewSchema,
    ClickHouseViewScope,
    ClickHouseViewScopeTarget,
    ContainerKind,
    ContainerRef,
    NativeSchemaChangePlan,
    NativeSchemaExecuteChangeRequest,
    NativeSchemaExecuteCreateRequest,
    NativeSchemaMutationPreview,
} from "@/types/ipc";

export interface ClickHouseViewSchemaTransport {
    invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T>;
}

class TauriClickHouseViewSchemaTransport
    implements ClickHouseViewSchemaTransport
{
    invoke<T>(
        command: string,
        args: Record<string, unknown>,
        options?: ApiInvokeOptions,
    ): Promise<T> {
        return apiInvoke<T>(command, args, options);
    }
}

export const defaultClickHouseViewSchemaTransport: ClickHouseViewSchemaTransport =
    new TauriClickHouseViewSchemaTransport();

export async function getClickHouseViewRuntimeSupport(
    transport: ClickHouseViewSchemaTransport,
    input: {
        profileId: string;
        database: string | null;
        ownerTabRuntimeId: string | null;
    },
): Promise<ClickHouseViewRuntimeSupport> {
    assertProfileId(input.profileId);
    assertOptionalOwner(input.ownerTabRuntimeId);
    return transport.invoke<ClickHouseViewRuntimeSupport>(
        "get_clickhouse_view_runtime_support",
        {
            profileId: input.profileId,
            database: normalizeOptional(input.database),
            ownerTabRuntimeId: normalizeOptional(input.ownerTabRuntimeId),
        },
        { silent: true },
    );
}

export async function describeClickHouseViewSchema(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; request: ClickHouseViewDescribeRequest },
): Promise<ClickHouseViewSchema> {
    assertProfileId(input.profileId);
    assertDescribeRequest(input.request);
    return transport.invoke<ClickHouseViewSchema>(
        "describe_clickhouse_view_schema",
        { profileId: input.profileId, request: input.request },
        { silent: true },
    );
}

export async function previewCreateClickHouseView(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; target: ClickHouseViewCreateTarget },
): Promise<NativeSchemaMutationPreview> {
    assertProfileId(input.profileId);
    assertCreateTarget(input.target);
    return transport.invoke<NativeSchemaMutationPreview>(
        "preview_create_clickhouse_view",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function createClickHouseView(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteCreateRequest },
): Promise<ClickHouseViewCreateResult> {
    assertProfileId(input.profileId);
    if (input.request.target.kind !== "clickhouse_view") {
        throw new Error("ClickHouse View create requires a View target");
    }
    assertCreateTarget(input.request.target.target);
    assertCreateBaseline(
        input.request.target.target.desired.scope,
        input.request.baseline,
    );
    return transport.invoke<ClickHouseViewCreateResult>(
        "create_clickhouse_view",
        { profileId: input.profileId, request: input.request },
    );
}

export async function previewChangeClickHouseView(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; target: ClickHouseViewChangeTarget },
): Promise<NativeSchemaChangePlan> {
    assertProfileId(input.profileId);
    assertChangeTarget(input.target);
    return transport.invoke<NativeSchemaChangePlan>(
        "preview_change_clickhouse_view",
        { profileId: input.profileId, target: input.target },
        { silent: true },
    );
}

export async function executeClickHouseViewChange(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; request: NativeSchemaExecuteChangeRequest },
): Promise<ClickHouseViewChangeResult> {
    assertProfileId(input.profileId);
    const target = nativeChangeTarget(input.request);
    assertChangeTarget(target);
    const cluster = baselineScope(target).kind === "cluster";
    if (
        (cluster && input.request.baseline.kind !== "clickhouse_cluster_view") ||
        (!cluster && input.request.baseline.kind !== "clickhouse_view")
    ) {
        throw new Error("ClickHouse View change baseline does not match its scope");
    }
    return transport.invoke<ClickHouseViewChangeResult>(
        "execute_clickhouse_view_change",
        { profileId: input.profileId, request: input.request },
    );
}

export async function listClickHouseTemporaryViews(
    transport: ClickHouseViewSchemaTransport,
    input: { profileId: string; ownerTabRuntimeId: string },
): Promise<ClickHouseViewSchema[]> {
    assertProfileId(input.profileId);
    assertRequiredText(input.ownerTabRuntimeId, "owner tab runtime");
    return transport.invoke<ClickHouseViewSchema[]>(
        "list_clickhouse_temporary_views",
        {
            profileId: input.profileId,
            ownerTabRuntimeId: input.ownerTabRuntimeId,
        },
        { silent: true },
    );
}

export function isClickHouseViewContainer(
    container: ContainerRef | null | undefined,
): container is ContainerRef & {
    kind: "view" | "materialized_view";
    table: string;
} {
    return (
        container != null &&
        (container.kind === "view" || container.kind === "materialized_view") &&
        hasText(container.table)
    );
}

function assertDescribeRequest(request: ClickHouseViewDescribeRequest): void {
    if (!isClickHouseViewContainer(request.container)) {
        throw new Error("ClickHouse View Describe requires a View or Materialized View");
    }
    if (request.ownerTabRuntimeId != null) {
        assertRequiredText(request.ownerTabRuntimeId, "owner tab runtime");
        if (hasText(request.container.database)) {
            throw new Error("Temporary ClickHouse View Describe must not include a database");
        }
    } else if (!hasText(request.container.database)) {
        throw new Error("Persistent ClickHouse View Describe requires a database");
    }
}

function assertCreateTarget(target: ClickHouseViewCreateTarget): void {
    assertDefinitionIdentity(
        target.desired.family,
        target.desired.address.objectKind,
        target.desired.scope,
    );
    assertRequiredText(target.desired.address.name, "View name");
    assertRequiredText(target.expectedSupportRevision, "support revision");
}

function assertChangeTarget(target: ClickHouseViewChangeTarget): void {
    const baseline = target.target.baseline;
    assertDefinitionIdentity(
        baseline.family,
        baseline.identity.address.objectKind,
        scopeTarget(baseline.scope),
    );
    if (target.kind === "alter") {
        assertDefinitionIdentity(
            target.target.desired.family,
            target.target.desired.address.objectKind,
            target.target.desired.scope,
        );
    }
    if (target.kind === "rename") {
        assertViewKind(baseline.family, target.target.destination.objectKind);
        assertRequiredText(
            target.target.expectedDestinationAbsenceRevision,
            "destination absence revision",
        );
    }
}

function nativeChangeTarget(
    request: NativeSchemaExecuteChangeRequest,
): ClickHouseViewChangeTarget {
    switch (request.target.kind) {
        case "clickhouse_view_alter":
            return { kind: "alter", target: request.target.target };
        case "clickhouse_view_rename":
            return { kind: "rename", target: request.target.target };
        case "clickhouse_view_drop":
            return { kind: "drop", target: request.target.target };
        default:
            throw new Error("ClickHouse View change requires a View target");
    }
}

function assertDefinitionIdentity(
    family: ClickHouseViewFamily,
    objectKind: ContainerKind,
    scope: ClickHouseViewScopeTarget,
): void {
    assertViewKind(family, objectKind);
    if (family === "temporary" && scope.kind !== "temporary") {
        throw new Error("Temporary ClickHouse View requires owner scope");
    }
    if (family !== "temporary" && scope.kind === "temporary") {
        throw new Error("Persistent ClickHouse View cannot use owner scope");
    }
}

function assertViewKind(
    family: ClickHouseViewFamily,
    objectKind: ContainerKind,
): void {
    const expected =
        family === "materialized" || family === "refreshable_materialized"
            ? "materialized_view"
            : "view";
    if (objectKind !== expected) {
        throw new Error(`ClickHouse ${family} requires ${expected} ownership`);
    }
}

function assertCreateBaseline(
    scope: ClickHouseViewScopeTarget,
    baseline: NativeSchemaExecuteCreateRequest["baseline"],
): void {
    if (scope.kind === "cluster" && baseline?.kind !== "clickhouse_cluster_view") {
        throw new Error("Cluster ClickHouse View create requires a cluster baseline");
    }
    if (scope.kind !== "cluster" && baseline != null) {
        throw new Error("Local ClickHouse View create must not include a cluster baseline");
    }
}

function baselineScope(target: ClickHouseViewChangeTarget): ClickHouseViewScope {
    return target.target.baseline.scope;
}

function scopeTarget(scope: ClickHouseViewScope): ClickHouseViewScopeTarget {
    switch (scope.kind) {
        case "local":
            return scope;
        case "cluster":
            return scope;
        case "temporary":
            return {
                kind: "temporary",
                value: { ownerTabRuntimeId: scope.value.ownerTabRuntimeId },
            };
    }
}

function assertProfileId(profileId: string): void {
    assertRequiredText(profileId, "profile id");
}

function assertOptionalOwner(owner: string | null): void {
    if (owner != null) {
        assertRequiredText(owner, "owner tab runtime");
    }
}

function assertRequiredText(value: string, field: string): void {
    if (!hasText(value)) {
        throw new Error(`ClickHouse View ${field} is required`);
    }
}

function hasText(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function normalizeOptional(value: string | null): string | null {
    return value == null ? null : value.trim();
}
