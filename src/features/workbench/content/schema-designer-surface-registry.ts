import {
    buildClickHouseTableDesignTabOpenRequest,
    buildClickHouseViewDesignTabOpenRequest,
    buildTableDesignTabOpenRequest,
    type ContentTabOpenRequest,
} from "@/features/workbench/content/content-tab-lifecycle-registry";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";
import type { TabType } from "@/store/slices/workbench-tabs-slice";
import type {
    ContainerKind,
    ContainerRef,
    DriverCapabilities,
} from "@/types/ipc";

export type SchemaDesignerMode = "create" | "edit";

export interface SchemaDesignerSurfaceResolveInput {
    driverName: string;
    objectKind: ContainerKind;
    mode: SchemaDesignerMode;
    capabilities: DriverCapabilities;
}

export interface SchemaDesignerOpenOptions {
    mode: SchemaDesignerMode;
    container?: ContainerRef | null;
    parentContainer?: ContainerRef | null;
    objectKind: ContainerKind;
    ownerTabRuntimeId?: string | null;
    title?: string;
}

export interface SchemaDesignerSurfaceRegistration<
    TType extends TabType = TabType,
> {
    tabType: TType;
    matches: (input: SchemaDesignerSurfaceResolveInput) => boolean;
    canWrite: (input: SchemaDesignerSurfaceResolveInput) => boolean;
    buildOpenRequest: (
        profileId: string,
        options: SchemaDesignerOpenOptions,
    ) => ContentTabOpenRequest<TType>;
}

type SchemaDesignerTabType = Extract<
    TabType,
    "table_design" | "clickhouse_table_design" | "clickhouse_view_design"
>;
type AnySchemaDesignerSurfaceRegistration = {
    [K in SchemaDesignerTabType]: SchemaDesignerSurfaceRegistration<K>;
}[SchemaDesignerTabType];

const RELATIONAL_TABLE_DESIGN_DRIVERS = new Set([
    "mysql",
    "postgres",
    "oracle",
]);

const clickHouseViewDesignRegistration: SchemaDesignerSurfaceRegistration<"clickhouse_view_design"> =
    {
        tabType: "clickhouse_view_design",
        matches: (input) =>
            input.driverName === "clickhouse" &&
            (input.objectKind === "view" ||
                input.objectKind === "materialized_view") &&
            input.capabilities.schemaBrowser,
        canWrite: (input) =>
            input.driverName === "clickhouse" &&
            (input.objectKind === "view" ||
                input.objectKind === "materialized_view") &&
            supportsSchemaMutation(
                input.capabilities,
                input.objectKind,
                input.mode === "create" ? "create" : "alter",
            ),
        buildOpenRequest: (profileId, options) => {
            if (options.mode === "create") {
                return buildClickHouseViewDesignTabOpenRequest(profileId, {
                    mode: "create",
                    objectKind: options.objectKind,
                    parentContainer: options.parentContainer ?? null,
                });
            }
            return buildClickHouseViewDesignTabOpenRequest(profileId, {
                mode: "edit",
                objectKind: options.objectKind,
                container: options.container ?? null,
            });
        },
    };

const clickHouseTableDesignRegistration: SchemaDesignerSurfaceRegistration<"clickhouse_table_design"> =
    {
        tabType: "clickhouse_table_design",
        matches: (input) => {
            if (
                input.driverName !== "clickhouse" ||
                input.objectKind !== "table"
            ) {
                return false;
            }
            if (input.mode === "create") {
                return supportsSchemaMutation(
                    input.capabilities,
                    "table",
                    "create",
                );
            }
            return input.capabilities.schemaBrowser;
        },
        canWrite: (input) =>
            input.driverName === "clickhouse" &&
            input.objectKind === "table" &&
            supportsSchemaMutation(
                input.capabilities,
                "table",
                input.mode === "create" ? "create" : "alter",
            ),
        buildOpenRequest: (profileId, options) => {
            if (options.mode === "create") {
                if (!options.parentContainer) {
                    throw new Error("新建 ClickHouse 表需要有效的数据库地址");
                }
                return buildClickHouseTableDesignTabOpenRequest(profileId, {
                    mode: "create",
                    parentContainer: options.parentContainer,
                });
            }
            if (!options.container) {
                throw new Error("编辑 ClickHouse 表需要有效的表地址");
            }
            return buildClickHouseTableDesignTabOpenRequest(profileId, {
                mode: "edit",
                container: options.container,
            });
        },
    };

const relationalTableDesignRegistration: SchemaDesignerSurfaceRegistration<"table_design"> =
    {
        tabType: "table_design",
        matches: (input) => {
            if (
                !RELATIONAL_TABLE_DESIGN_DRIVERS.has(input.driverName) ||
                input.objectKind !== "table"
            ) {
                return false;
            }
            return supportsSchemaMutation(
                input.capabilities,
                "table",
                input.mode === "create" ? "create" : "alter",
            );
        },
        canWrite: (input) =>
            RELATIONAL_TABLE_DESIGN_DRIVERS.has(input.driverName) &&
            input.objectKind === "table" &&
            supportsSchemaMutation(
                input.capabilities,
                "table",
                input.mode === "create" ? "create" : "alter",
            ),
        buildOpenRequest: (profileId, options) => {
            if (options.mode === "edit" && !options.container) {
                throw new Error("编辑表结构需要有效的表地址");
            }
            return buildTableDesignTabOpenRequest(profileId, options);
        },
    };

const registrations = [
    clickHouseViewDesignRegistration,
    clickHouseTableDesignRegistration,
    relationalTableDesignRegistration,
] satisfies AnySchemaDesignerSurfaceRegistration[];

export function resolveSchemaDesignerSurface(
    input: SchemaDesignerSurfaceResolveInput,
): AnySchemaDesignerSurfaceRegistration | null {
    return registrations.find((registration) => registration.matches(input)) ?? null;
}
