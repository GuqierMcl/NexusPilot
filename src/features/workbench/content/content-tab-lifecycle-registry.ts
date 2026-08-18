import { normalizeSqlContext } from "@/features/workbench/content/components/sql-editor/sql-editor-utils";
import type {
    TabPayloadMap,
    TabType,
    WorkbenchTab,
} from "@/store/slices/workbench-tabs-slice";
import type { ConnectionRuntimeInfo, ContainerRef } from "@/types/ipc";
import type { SavedQuery, SqlExecutionContext } from "@/types/saved-queries";
import type { TableDesignMode } from "@/types/table-design";

export interface ContentTabOpenRequest<TType extends TabType = TabType> {
    type: TType;
    id: string;
    title: string;
    payload: TabPayloadMap[TType];
    isDirty?: boolean;
    isPinned?: boolean;
    isExecuting?: boolean;
}

export interface ContentTabLifecycleRegistration<
    TType extends TabType = TabType,
> {
    type: TType;
    createTab: (
        request: ContentTabOpenRequest<TType>,
    ) => Extract<WorkbenchTab, { type: TType }>;
    findExistingTab: (
        tabs: WorkbenchTab[],
        request: ContentTabOpenRequest<TType>,
    ) => Extract<WorkbenchTab, { type: TType }> | undefined;
    matchesContainer?: (
        tab: Extract<WorkbenchTab, { type: TType }>,
        profileId: string,
        container: ContainerRef,
    ) => boolean;
    getOwnerTabId?: (
        tab: Extract<WorkbenchTab, { type: TType }>,
    ) => string | null;
    getDependentTabIds?: (
        tabs: WorkbenchTab[],
        ownerTabId: string,
    ) => string[];
}

type SqlEditorTab = Extract<WorkbenchTab, { type: "sql_editor" }>;
type TableDesignTab = Extract<WorkbenchTab, { type: "table_design" }>;
type ClickHouseTableDesignTab = Extract<
    WorkbenchTab,
    { type: "clickhouse_table_design" }
>;
type ClickHouseViewDesignTab = Extract<
    WorkbenchTab,
    { type: "clickhouse_view_design" }
>;
type PlaceholderTabType = Extract<
    TabType,
    "json_viewer" | "graph_topology" | "dashboard"
>;
type AnyContentTabLifecycleRegistration = {
    [K in TabType]: ContentTabLifecycleRegistration<K>;
}[TabType];

function createDefaultTab<TType extends TabType>(
    request: ContentTabOpenRequest<TType>,
): Extract<WorkbenchTab, { type: TType }> {
    return {
        id: request.id,
        type: request.type,
        title: request.title,
        isDirty: request.isDirty ?? false,
        isPinned: request.isPinned ?? false,
        ...(request.isExecuting == null
            ? {}
            : { isExecuting: request.isExecuting }),
        payload: request.payload,
    } as Extract<WorkbenchTab, { type: TType }>;
}

function findById<TType extends TabType>(
    tabs: WorkbenchTab[],
    request: ContentTabOpenRequest<TType>,
): Extract<WorkbenchTab, { type: TType }> | undefined {
    return tabs.find(
        (tab): tab is Extract<WorkbenchTab, { type: TType }> =>
            tab.type === request.type && tab.id === request.id,
    );
}

function createDefaultLifecycleRegistration<TType extends TabType>(
    type: TType,
): ContentTabLifecycleRegistration<TType> {
    return {
        type,
        createTab: createDefaultTab,
        findExistingTab: findById,
    };
}

function randomTabSuffix(): string {
    return (
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
}

function buildPreOpenRuntimeInfo(params: {
    profileId: string;
    driverName: string;
    sqlExecutor?: boolean;
    dataTableBrowser?: boolean;
}): ConnectionRuntimeInfo {
    return {
        profileId: params.profileId,
        driverName: params.driverName,
        capabilities: {
            schemaBrowser: false,
            schemaMutator: false,
            dataTableBrowser: params.dataTableBrowser ?? false,
            tableRowMutator: false,
            tableRowInserter: false,
            transactionManager: false,
            sqlExecutor: params.sqlExecutor ?? false,
            keyValueBrowser: false,
            graphQueryer: false,
            vectorSearcher: false,
        },
    };
}

export function getContainerObjectName(container: ContainerRef): string {
    return container.table ?? container.objectName ?? "";
}

export function buildTableDataTabId(
    profileId: string,
    container: ContainerRef,
): string {
    const objectName = getContainerObjectName(container);
    return `table_data::${profileId}::${container.kind}::${container.database ?? ""}::${container.schema ?? ""}::${objectName}`;
}

export function buildTableDesignEditTabId(
    profileId: string,
    container: ContainerRef,
): string {
    const objectName = getContainerObjectName(container);
    return `table_design::edit::${profileId}::${container.kind}::${container.database ?? ""}::${container.schema ?? ""}::${objectName}`;
}

export function buildTableDesignCreateTabId(profileId: string): string {
    return `table_design::create::${profileId}::${randomTabSuffix()}`;
}

export function buildClickHouseTableDesignEditTabId(
    profileId: string,
    container: ContainerRef,
): string {
    const objectName = getContainerObjectName(container);
    return `clickhouse_table_design::edit::${profileId}::${container.database ?? ""}::${objectName}`;
}

export function buildClickHouseTableDesignCreateTabId(profileId: string): string {
    return `clickhouse_table_design::create::${profileId}::${randomTabSuffix()}`;
}

export function buildClickHouseViewDesignEditTabId(
    profileId: string,
    container: ContainerRef,
): string {
    const objectName = getContainerObjectName(container);
    return `clickhouse_view_design::edit::${profileId}::${container.kind}::${container.database ?? ""}::${objectName}`;
}

export function buildClickHouseViewDesignCreateTabId(profileId: string): string {
    return `clickhouse_view_design::create::${profileId}::${randomTabSuffix()}`;
}

export function isSameTableDesignContainer(
    left?: ContainerRef | null,
    right?: ContainerRef | null,
): boolean {
    if (!left || !right) return false;
    return (
        left.kind === right.kind &&
        (left.database ?? "") === (right.database ?? "") &&
        (left.schema ?? "") === (right.schema ?? "") &&
        getContainerObjectName(left) === getContainerObjectName(right)
    );
}

export function buildTableDesignEditTitle(container: ContainerRef): string {
    return container.table ?? container.objectName ?? "表结构";
}

export function buildTableDesignCreateTitle(
    parentContainer?: ContainerRef | null,
    explicitTitle?: string,
): string {
    const databaseName = parentContainer?.database ?? "";
    const schemaName = parentContainer?.schema ?? "";
    const context = [databaseName, schemaName].filter(Boolean).join(".");
    if (context) {
        return `新建表 · ${context}`;
    }

    if (explicitTitle && explicitTitle !== "Tables") {
        return `新建表 · ${explicitTitle}`;
    }

    return "新建表 · 目标未确定";
}

export function buildKeyValueTabId(
    profileId: string,
    dbIndex: number,
    pattern = "*",
    selectedKey?: string,
): string {
    return `key_value::${profileId}::${dbIndex}::${selectedKey ?? pattern}`;
}

export function buildSqlEditorTabId(
    profileId: string,
    savedQueryId?: string | null,
): string {
    if (savedQueryId) {
        return `sql_editor::saved::${profileId}::${savedQueryId}`;
    }
    return `sql_editor::${profileId}::${randomTabSuffix()}`;
}

const sqlEditorLifecycleRegistration: ContentTabLifecycleRegistration<"sql_editor"> =
    {
        ...createDefaultLifecycleRegistration("sql_editor"),
        findExistingTab: (tabs, request) => {
            const savedQueryId = request.payload.savedQueryId;
            if (savedQueryId) {
                return findExistingSavedSqlEditorTab(
                    tabs,
                    request.payload.profileId,
                    savedQueryId,
                );
            }
            return findById(tabs, request);
        },
    };

const tableDesignLifecycleRegistration: ContentTabLifecycleRegistration<"table_design"> =
    {
        ...createDefaultLifecycleRegistration("table_design"),
        findExistingTab: (tabs, request) => {
            const existingById = findById(tabs, request);
            if (existingById) return existingById;

            if (request.payload.mode !== "edit" || !request.payload.container) {
                return undefined;
            }

            return tabs.find(
                (tab): tab is TableDesignTab =>
                    tab.type === "table_design" &&
                    tab.payload.profileId === request.payload.profileId &&
                    tab.payload.mode === "edit" &&
                    isSameTableDesignContainer(
                        tab.payload.container,
                        request.payload.container,
                    ),
            );
        },
        matchesContainer: (tab, profileId, container) =>
            tab.payload.profileId === profileId &&
            tab.payload.mode === "edit" &&
            tab.payload.container != null &&
            isSameTableDesignContainer(tab.payload.container, container),
    };

const tableDataLifecycleRegistration: ContentTabLifecycleRegistration<"table_data"> =
    {
        ...createDefaultLifecycleRegistration("table_data"),
        matchesContainer: (tab, profileId, container) =>
            tab.payload.profileId === profileId &&
            isSameTableDesignContainer(tab.payload.container, container),
    };

const clickHouseTableDesignLifecycleRegistration: ContentTabLifecycleRegistration<"clickhouse_table_design"> =
    {
        ...createDefaultLifecycleRegistration("clickhouse_table_design"),
        findExistingTab: (tabs, request) => {
            if (request.payload.mode === "create") return undefined;

            const existingById = findById(tabs, request);
            if (existingById) return existingById;

            return tabs.find(
                (tab): tab is ClickHouseTableDesignTab =>
                    tab.type === "clickhouse_table_design" &&
                    tab.payload.profileId === request.payload.profileId &&
                    tab.payload.mode === "edit" &&
                    isSameTableDesignContainer(
                        tab.payload.container,
                        request.payload.container,
                    ),
            );
        },
        matchesContainer: (tab, profileId, container) =>
            tab.payload.profileId === profileId &&
            tab.payload.mode === "edit" &&
            isSameTableDesignContainer(tab.payload.container, container),
    };

const clickHouseViewDesignLifecycleRegistration: ContentTabLifecycleRegistration<"clickhouse_view_design"> =
    {
        ...createDefaultLifecycleRegistration("clickhouse_view_design"),
        findExistingTab: (tabs, request) => {
            if (request.payload.mode !== "edit") return undefined;
            const requestPayload = request.payload;
            const existingById = findById(tabs, request);
            if (existingById) return existingById;
            return tabs.find(
                (tab): tab is ClickHouseViewDesignTab =>
                    tab.type === "clickhouse_view_design" &&
                    tab.payload.profileId === requestPayload.profileId &&
                    tab.payload.mode === "edit" &&
                    isSameTableDesignContainer(
                        tab.payload.container,
                        requestPayload.container,
                    ),
            );
        },
        matchesContainer: (tab, profileId, container) =>
            tab.payload.profileId === profileId &&
            tab.payload.mode === "edit" &&
            isSameTableDesignContainer(tab.payload.container, container),
        getOwnerTabId: (tab) =>
            tab.payload.mode === "temporary"
                ? tab.payload.ownerTabRuntimeId
                : null,
    };

const registrations = [
    sqlEditorLifecycleRegistration,
    tableDataLifecycleRegistration,
    createDefaultLifecycleRegistration("key_value"),
    tableDesignLifecycleRegistration,
    clickHouseTableDesignLifecycleRegistration,
    clickHouseViewDesignLifecycleRegistration,
    createDefaultLifecycleRegistration("json_viewer"),
    createDefaultLifecycleRegistration("graph_topology"),
    createDefaultLifecycleRegistration("dashboard"),
] satisfies AnyContentTabLifecycleRegistration[];

export const CONTENT_TAB_LIFECYCLE_REGISTRY = Object.fromEntries(
    registrations.map((registration) => [registration.type, registration]),
) as { [K in TabType]: ContentTabLifecycleRegistration<K> };

export function getContentTabLifecycleRegistration<TType extends TabType>(
    type: TType,
): ContentTabLifecycleRegistration<TType> {
    return CONTENT_TAB_LIFECYCLE_REGISTRY[
        type
    ] as ContentTabLifecycleRegistration<TType>;
}

export function createWorkbenchTabFromOpenRequest<TType extends TabType>(
    request: ContentTabOpenRequest<TType>,
): Extract<WorkbenchTab, { type: TType }> {
    return getContentTabLifecycleRegistration(request.type).createTab(request);
}

export function findExistingContentTabForOpenRequest<TType extends TabType>(
    tabs: WorkbenchTab[],
    request: ContentTabOpenRequest<TType>,
): Extract<WorkbenchTab, { type: TType }> | undefined {
    return getContentTabLifecycleRegistration(request.type).findExistingTab(
        tabs,
        request,
    );
}

export function matchesContentTabContainer(
    tab: WorkbenchTab,
    profileId: string,
    container: ContainerRef,
): boolean {
    const registration = getContentTabLifecycleRegistration(
        tab.type,
    ) as ContentTabLifecycleRegistration;
    return registration.matchesContainer?.(tab, profileId, container) ?? false;
}

export function getContentTabOwnerId(tab: WorkbenchTab): string | null {
    const registration = getContentTabLifecycleRegistration(
        tab.type,
    ) as ContentTabLifecycleRegistration;
    return registration.getOwnerTabId?.(tab) ?? null;
}

export function expandContentTabClosingSet(
    tabs: WorkbenchTab[],
    requestedTabIds: Iterable<string>,
): WorkbenchTab[] {
    const closingIds = new Set(requestedTabIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const tab of tabs) {
            const ownerId = getContentTabOwnerId(tab);
            if (ownerId != null && closingIds.has(ownerId) && !closingIds.has(tab.id)) {
                closingIds.add(tab.id);
                changed = true;
            }
            const registration = getContentTabLifecycleRegistration(
                tab.type,
            ) as ContentTabLifecycleRegistration;
            for (const dependentId of
                registration.getDependentTabIds?.(tabs, tab.id) ?? []) {
                if (closingIds.has(tab.id) && !closingIds.has(dependentId)) {
                    closingIds.add(dependentId);
                    changed = true;
                }
            }
        }
    }
    return tabs.filter((tab) => closingIds.has(tab.id));
}

export function contentTabOwnsBackendRuntime(tab: WorkbenchTab): boolean {
    return tab.type !== "clickhouse_view_design";
}

export function buildSqlEditorTabOpenRequest(
    profileId: string,
    options: {
        runtime: ConnectionRuntimeInfo;
        title?: string;
        context?: SqlExecutionContext | null;
        tabId?: string;
    },
): ContentTabOpenRequest<"sql_editor"> {
    const id = options.tabId ?? buildSqlEditorTabId(profileId);
    return {
        id,
        type: "sql_editor",
        title: options.title ?? "未命名查询",
        payload: {
            profileId,
            tabRuntimeId: id,
            runtime: options.runtime,
            savedQueryId: null,
            initialContext: normalizeSqlContext(options.context),
        },
    };
}

export function buildSavedQuerySqlEditorTabOpenRequest(
    query: SavedQuery,
    runtime: ConnectionRuntimeInfo,
): ContentTabOpenRequest<"sql_editor"> {
    const id = buildSqlEditorTabId(query.profileId, query.id);
    const context = normalizeSqlContext({
        database: query.databaseName ?? null,
        schema: query.schemaName ?? null,
    });

    return {
        id,
        type: "sql_editor",
        title: query.title,
        payload: {
            profileId: query.profileId,
            tabRuntimeId: id,
            runtime,
            savedQueryId: query.id,
            initialContext: context,
        },
    };
}

export function buildSavedQuerySqlEditorPreOpenRequest(
    query: SavedQuery,
): ContentTabOpenRequest<"sql_editor"> {
    return buildSavedQuerySqlEditorTabOpenRequest(
        query,
        buildPreOpenRuntimeInfo({
            profileId: query.profileId,
            driverName: query.driver,
            sqlExecutor: true,
        }),
    );
}

export function buildTableDataTabOpenRequest(
    profileId: string,
    container: ContainerRef,
    runtime: ConnectionRuntimeInfo,
): ContentTabOpenRequest<"table_data"> {
    const id = buildTableDataTabId(profileId, container);
    return {
        id,
        type: "table_data",
        title: container.table ?? "数据",
        payload: {
            profileId,
            tabRuntimeId: id,
            runtime,
            container,
        },
    };
}

export function buildTableDataPreOpenRequest(
    profileId: string,
    container: ContainerRef,
): ContentTabOpenRequest<"table_data"> {
    return buildTableDataTabOpenRequest(
        profileId,
        container,
        buildPreOpenRuntimeInfo({
            profileId,
            driverName: "",
            dataTableBrowser: true,
        }),
    );
}

export function buildTableDesignTabOpenRequest(
    profileId: string,
    options: {
        mode: TableDesignMode;
        container?: ContainerRef | null;
        parentContainer?: ContainerRef | null;
        title?: string;
    },
): ContentTabOpenRequest<"table_design"> {
    const mode = options.mode;
    const container = options.container ?? null;
    const parentContainer = options.parentContainer ?? null;
    const id =
        mode === "edit" && container
            ? buildTableDesignEditTabId(profileId, container)
            : buildTableDesignCreateTabId(profileId);
    const title =
        mode === "edit" && container
            ? buildTableDesignEditTitle(container)
            : buildTableDesignCreateTitle(parentContainer, options.title);

    return {
        id,
        type: "table_design",
        title,
        payload: {
            profileId,
            tabRuntimeId: id,
            mode,
            container,
            parentContainer,
        },
    };
}

export function buildClickHouseTableDesignTabOpenRequest(
    profileId: string,
    options:
        | { mode: "create"; parentContainer: ContainerRef }
        | { mode: "edit"; container: ContainerRef },
): ContentTabOpenRequest<"clickhouse_table_design"> {
    if (options.mode === "create") {
        const { parentContainer } = options;
        if (
            parentContainer.kind !== "database" ||
            !parentContainer.database?.trim() ||
            parentContainer.schema != null
        ) {
            throw new Error("新建 ClickHouse 表需要无 schema 的有效数据库地址");
        }
        const id = buildClickHouseTableDesignCreateTabId(profileId);
        return {
            id,
            type: "clickhouse_table_design",
            title: `新建 ClickHouse 表 · ${parentContainer.database}`,
            payload: {
                profileId,
                tabRuntimeId: id,
                mode: "create",
                container: null,
                parentContainer,
            },
        };
    }

    const { container } = options;
    const objectName = getContainerObjectName(container);
    if (
        container.kind !== "table" ||
        !container.database?.trim() ||
        container.schema != null ||
        !objectName.trim()
    ) {
        throw new Error("ClickHouse 表结构标签页需要有效的数据库与表地址");
    }

    const id = buildClickHouseTableDesignEditTabId(profileId, container);
    return {
        id,
        type: "clickhouse_table_design",
        title: objectName,
        payload: {
            profileId,
            tabRuntimeId: id,
            mode: "edit",
            container,
            parentContainer: null,
        },
    };
}

export function buildClickHouseViewDesignTabOpenRequest(
    profileId: string,
    options:
        | {
              mode: "create";
              objectKind: ContainerRef["kind"];
              parentContainer: ContainerRef | null;
          }
        | {
              mode: "edit";
              objectKind: ContainerRef["kind"];
              container: ContainerRef | null;
          }
        | {
              mode: "temporary";
              ownerTabRuntimeId: string;
          },
): ContentTabOpenRequest<"clickhouse_view_design"> {
    if (options.mode === "temporary") {
        if (!options.ownerTabRuntimeId.trim()) {
            throw new Error("Temporary View 设计器需要 owner SQL runtime");
        }
        const id = `clickhouse_view_design::temporary::${profileId}::${options.ownerTabRuntimeId}::${randomTabSuffix()}`;
        return {
            id,
            type: "clickhouse_view_design",
            title: "新建 Temporary View",
            payload: {
                profileId,
                tabRuntimeId: id,
                mode: "temporary",
                container: null,
                ownerTabRuntimeId: options.ownerTabRuntimeId,
            },
        };
    }

    if (options.mode === "create") {
        const parent = options.parentContainer;
        if (
            (options.objectKind !== "view" &&
                options.objectKind !== "materialized_view") ||
            parent?.kind !== "database" ||
            !parent.database?.trim() ||
            parent.schema != null
        ) {
            throw new Error("新建 ClickHouse View 需要无 schema 的有效数据库地址");
        }
        const id = buildClickHouseViewDesignCreateTabId(profileId);
        return {
            id,
            type: "clickhouse_view_design",
            title: `新建 ${options.objectKind === "materialized_view" ? "Materialized View" : "View"} · ${parent.database}`,
            payload: {
                profileId,
                tabRuntimeId: id,
                mode: "create",
                parentContainer: parent,
                ownerTabRuntimeId: null,
            },
        };
    }

    const container = options.container;
    const name = container ? getContainerObjectName(container) : "";
    if (
        container == null ||
        (container.kind !== "view" && container.kind !== "materialized_view") ||
        container.kind !== options.objectKind ||
        !container.database?.trim() ||
        container.schema != null ||
        !name.trim()
    ) {
        throw new Error("ClickHouse View 设计器需要有效的 View 地址");
    }
    const id = buildClickHouseViewDesignEditTabId(profileId, container);
    return {
        id,
        type: "clickhouse_view_design",
        title: name,
        payload: {
            profileId,
            tabRuntimeId: id,
            mode: "edit",
            container,
            ownerTabRuntimeId: null,
        },
    };
}

export function buildKeyValueTabOpenRequest(
    profileId: string,
    dbIndex: number,
    pattern = "*",
    selectedKey?: string,
): ContentTabOpenRequest<"key_value"> {
    const id = buildKeyValueTabId(profileId, dbIndex, pattern, selectedKey);
    return {
        id,
        type: "key_value",
        title: `Redis DB ${dbIndex}`,
        payload: {
            profileId,
            dbIndex,
            pattern,
            selectedKey,
        },
    };
}

export function buildPlaceholderTabOpenRequest<TType extends PlaceholderTabType>(
    type: TType,
    options: {
        id: string;
        title: string;
    },
): ContentTabOpenRequest<TType> {
    return {
        id: options.id,
        type,
        title: options.title,
        payload: {} as TabPayloadMap[TType],
    };
}

export function findExistingSavedSqlEditorTab(
    tabs: WorkbenchTab[],
    profileId: string,
    savedQueryId: string,
): SqlEditorTab | undefined {
    return tabs.find(
        (tab): tab is SqlEditorTab =>
            tab.type === "sql_editor" &&
            tab.payload.profileId === profileId &&
            tab.payload.savedQueryId === savedQueryId,
    );
}

export function retargetSqlEditorTab(
    tabs: WorkbenchTab[],
    tabId: string,
    savedQueryId: string,
    title: string,
    options?: { isDirty?: boolean },
): WorkbenchTab[] {
    let changed = false;
    const isDirty = options?.isDirty ?? false;
    const nextTabs = tabs.map((tab) => {
        if (tab.id !== tabId || tab.type !== "sql_editor") return tab;
        changed = true;
        return {
            ...tab,
            title,
            isDirty,
            payload: {
                ...tab.payload,
                savedQueryId,
            },
        };
    });

    return changed ? nextTabs : tabs;
}

export function retargetTableDesignTabToEdit(
    tabs: WorkbenchTab[],
    tabId: string,
    container: ContainerRef,
): WorkbenchTab[] {
    let changed = false;
    const nextTabs = tabs.map((tab) => {
        if (tab.id !== tabId || tab.type !== "table_design") return tab;

        changed = true;
        return {
            ...tab,
            title: buildTableDesignEditTitle(container),
            isDirty: false,
            payload: {
                ...tab.payload,
                mode: "edit" as const,
                container,
                parentContainer: null,
            },
        };
    });

    return changed ? nextTabs : tabs;
}

export function retargetClickHouseTableDesignTabToEdit(
    tabs: WorkbenchTab[],
    tabId: string,
    container: ContainerRef,
): WorkbenchTab[] {
    let changed = false;
    const nextTabs = tabs.map((tab) => {
        if (tab.id !== tabId || tab.type !== "clickhouse_table_design") {
            return tab;
        }

        changed = true;
        return {
            ...tab,
            title: buildTableDesignEditTitle(container),
            isDirty: false,
            payload: {
                ...tab.payload,
                mode: "edit" as const,
                container,
                parentContainer: null,
            },
        };
    });

    return changed ? nextTabs : tabs;
}

export function retargetClickHouseViewDesignTabToEdit(
    tabs: WorkbenchTab[],
    tabId: string,
    container: ContainerRef,
): WorkbenchTab[] {
    if (
        (container.kind !== "view" && container.kind !== "materialized_view") ||
        !container.database?.trim() ||
        !getContainerObjectName(container).trim()
    ) {
        throw new Error("ClickHouse View retarget 需要有效的持久化 View 地址");
    }
    let changed = false;
    const nextTabs = tabs.map((tab) => {
        if (tab.id !== tabId || tab.type !== "clickhouse_view_design") {
            return tab;
        }
        changed = true;
        return {
            ...tab,
            title: getContainerObjectName(container),
            isDirty: false,
            payload: {
                profileId: tab.payload.profileId,
                tabRuntimeId: tab.payload.tabRuntimeId,
                mode: "edit" as const,
                container,
                ownerTabRuntimeId: null,
            },
        };
    });
    return changed ? nextTabs : tabs;
}
