import {
    useCallback,
    useMemo,
    useRef,
    useState,
    type FC,
} from "react";

import {
    joinSchemaDdlStatements,
    SchemaDdlPreviewDrawer,
} from "@/features/workbench/content/components/schema-design/schema-ddl-preview-drawer";
import { supportsSchemaMutation } from "@/lib/schema-mutation-capabilities";
import { useConnectionSessionStore, useWorkbenchTabsStore } from "@/store";
import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";
import type {
    ClickHouseViewFamily,
    ClickHouseViewFamilySupport,
    ContainerRef,
} from "@/types/ipc";

import {
    canStartClickHouseViewDesignAction,
} from "./clickhouse-view-design-lifecycle";
import {
    createClickHouseViewDraft,
} from "./clickhouse-view-design-validation";
import { LiveViewEditor } from "./sections/live-view-editor";
import { MaterializedViewEditor } from "./sections/materialized-view-editor";
import { NormalViewEditor } from "./sections/normal-view-editor";
import { RefreshableViewEditor } from "./sections/refreshable-view-editor";
import { WindowViewEditor } from "./sections/window-view-editor";
import { useClickHouseViewDesign } from "./use-clickhouse-view-design";
import { useClickHouseViewToolbar } from "./use-clickhouse-view-toolbar";

interface ClickHouseViewDesignViewProps {
    tabId: string;
    profileId: string;
    mode: "create" | "edit" | "temporary";
    container: ContainerRef | null;
    parentContainer: ContainerRef | null;
    ownerTabRuntimeId: string | null;
    isActive: boolean;
}

const persistentFamilies = [
    "normal",
    "parameterized",
    "materialized",
    "refreshable_materialized",
    "window",
    "live",
    "temporary",
] satisfies ClickHouseViewFamily[];

function familySupport(
    draft: ClickHouseViewDesignDraft,
    support: ReturnType<typeof useClickHouseViewDesign>["state"]["support"],
): ClickHouseViewFamilySupport | null {
    if (!support) return null;
    switch (draft.family) {
        case "normal":
            return support.normal;
        case "parameterized":
            return support.parameterized;
        case "temporary":
            return support.temporary;
        case "materialized":
            return support.materialized;
        case "refreshable_materialized":
            return support.refreshableMaterialized;
        case "window":
            return support.window;
        case "live":
            return support.live;
    }
}

export const ClickHouseViewDesignView: FC<ClickHouseViewDesignViewProps> = ({
    tabId,
    profileId,
    mode,
    container,
    parentContainer,
    ownerTabRuntimeId,
    isActive,
}) => {
    const initialDraft = useMemo(() => {
        const family: ClickHouseViewFamily =
            mode === "temporary"
                ? "temporary"
                : container?.kind === "materialized_view"
                  ? "materialized"
                  : "normal";
        return createClickHouseViewDraft({
            family,
            database:
                mode === "temporary"
                    ? null
                    : (container?.database ?? parentContainer?.database ?? null),
            name: container?.table ?? container?.objectName ?? "",
            ownerTabRuntimeId,
        });
    }, [container, mode, ownerTabRuntimeId, parentContainer?.database]);
    const design = useClickHouseViewDesign({
        tabId,
        profileId,
        mode,
        container,
        ownerTabRuntimeId,
        initialDraft,
        isActive,
    });
    const capabilities = useConnectionSessionStore(
        (state) => state.sessions[profileId]?.capabilities,
    );
    const openClickHouseTemporaryViewTab = useWorkbenchTabsStore(
        (state) => state.openClickHouseTemporaryViewTab,
    );
    const operation = mode === "edit" ? "alter" : "create";
    const familyState = familySupport(design.state.draft, design.state.support);
    const canWrite =
        capabilities != null &&
        supportsSchemaMutation(
            capabilities,
            design.state.draft.address.objectKind,
            operation,
        ) &&
        familyState?.[operation].state === "supported" &&
        canStartClickHouseViewDesignAction(design.state, "preview");
    const [isDdlOpen, setIsDdlOpen] = useState(false);
    const drawerHost = useRef<HTMLDivElement>(null);
    const handlePreview = useCallback(async () => {
        await design.preview();
        setIsDdlOpen(true);
    }, [design]);
    const handleFamilyChange = useCallback(
        (family: ClickHouseViewFamily) => {
            if (mode === "create" && family === "temporary") {
                void openClickHouseTemporaryViewTab(profileId, null);
                return;
            }
            const next = createClickHouseViewDraft({
                family,
                database: design.state.draft.address.database,
                name: design.state.draft.address.name,
                ownerTabRuntimeId,
            });
            next.query = design.state.draft.query;
            next.comment = design.state.draft.comment;
            next.security = structuredClone(design.state.draft.security);
            design.updateDraft(next);
        },
        [design, mode, openClickHouseTemporaryViewTab, ownerTabRuntimeId, profileId],
    );

    useClickHouseViewToolbar({
        tabId,
        state: design.state,
        canWrite,
        pending: design.pending,
        isDirty: design.isDirty,
        issueCount: design.issues.length,
        onPreview: () => void handlePreview(),
        onApply: () => void design.apply(),
        onRefresh: design.refresh,
        onReset: design.reset,
    });

    const disabled = design.pending || !canWrite;
    const draft = design.state.draft;
    const supportState = familyState?.[operation].state ?? "unknown";
    const ddlText = joinSchemaDdlStatements(
        design.state.preview?.preview.statements ?? [],
    );

    return (
        <div
            ref={drawerHost}
            className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden"
        >
            <header className="grid shrink-0 gap-2 border-b px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h2 className="text-sm font-semibold">
                            {draft.address.name || "New ClickHouse View"}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {draft.family} · {draft.scope.kind} · support {supportState}
                        </p>
                    </div>
                    {design.state.backgroundWork && (
                        <span className="rounded border px-2 py-1 text-xs">
                            {design.state.backgroundWork.kind}: {design.state.backgroundWork.state}
                        </span>
                    )}
                </div>
                {supportState !== "supported" && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                        当前服务器支持为 {supportState}；保留远端事实，但 Preview/Apply 已关闭。
                    </p>
                )}
            </header>

            <div className="min-h-0 flex-1 overflow-auto p-4">
                <div className="mx-auto grid max-w-5xl gap-4">
                    <div className="grid gap-3 md:grid-cols-2">
                        <label className="grid gap-1 text-xs">
                            <span className="text-muted-foreground">Object name</span>
                            <input
                                className="h-8 rounded-md border bg-background px-2"
                                value={draft.address.name}
                                disabled={mode === "edit" || disabled}
                                onChange={(event) =>
                                    design.updateDraft({
                                        ...draft,
                                        address: {
                                            ...draft.address,
                                            name: event.target.value,
                                        },
                                    })
                                }
                            />
                        </label>
                        {mode === "create" && (
                            <label className="grid gap-1 text-xs">
                                <span className="text-muted-foreground">Family</span>
                                <select
                                    className="h-8 rounded-md border bg-background px-2"
                                    value={draft.family}
                                    disabled={design.pending}
                                    onChange={(event) =>
                                        handleFamilyChange(
                                            event.target.value as ClickHouseViewFamily,
                                        )
                                    }
                                >
                                    {persistentFamilies.map((family) => (
                                        <option key={family} value={family}>
                                            {family}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </div>

                    <label className="grid gap-1 text-xs">
                        <span className="text-muted-foreground">Single SELECT query body</span>
                        <textarea
                            className="min-h-44 resize-y rounded-md border bg-background p-3 font-mono text-xs"
                            value={draft.query}
                            disabled={disabled}
                            onChange={(event) =>
                                design.updateDraft({ ...draft, query: event.target.value })
                            }
                        />
                    </label>

                    {(draft.family === "normal" ||
                        draft.family === "parameterized" ||
                        draft.family === "temporary") && (
                        <NormalViewEditor
                            draft={draft}
                            disabled={disabled}
                            onChange={design.updateDraft}
                        />
                    )}
                    <MaterializedViewEditor
                        draft={draft}
                        disabled={disabled}
                        onChange={design.updateDraft}
                    />
                    <RefreshableViewEditor
                        draft={draft}
                        disabled={disabled}
                        onChange={design.updateDraft}
                    />
                    <WindowViewEditor
                        draft={draft}
                        disabled={disabled}
                        onChange={design.updateDraft}
                    />
                    <LiveViewEditor draft={draft} />

                    {design.issues.length > 0 && (
                        <div className="grid gap-1 rounded-md border border-destructive/40 p-3 text-xs text-destructive">
                            {design.issues.map((issue) => (
                                <p key={`${issue.code}:${issue.path}`}>{issue.message}</p>
                            ))}
                        </div>
                    )}
                    {ddlText && (
                        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">
                            {ddlText}
                        </pre>
                    )}
                </div>
            </div>
            <SchemaDdlPreviewDrawer
                isOpen={isDdlOpen}
                onOpenChange={setIsDdlOpen}
                containerRef={drawerHost.current}
                title="ClickHouse View DDL 预览"
                description="计划与当前 family、scope、support revision 和完整 baseline 绑定。"
                statements={design.state.preview?.preview.statements ?? []}
                warnings={design.state.preview?.preview.warnings ?? []}
                validationMessages={design.issues.map((issue) => issue.message)}
                isPending={design.pending}
                errorMessage={
                    design.supportQuery.error
                        ? String(design.supportQuery.error.message)
                        : null
                }
                onCopy={() => void navigator.clipboard.writeText(ddlText)}
                onExport={() => {
                    const url = URL.createObjectURL(
                        new Blob([ddlText], { type: "text/sql;charset=utf-8" }),
                    );
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = `${draft.address.name || "clickhouse-view"}.sql`;
                    anchor.click();
                    URL.revokeObjectURL(url);
                }}
            />
        </div>
    );
};
