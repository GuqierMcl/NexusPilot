import { useState, type FC } from "react";
import { Eraser, Layers3, Plus, RefreshCcw, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
    ClickHouseProjectionCreateDraft,
    ClickHouseTableObjectActionDraft,
} from "@/types/clickhouse-table-design";
import type { ClickHouseProjectionSchema } from "@/types/ipc";

interface ClickHouseProjectionsEditProps {
    projections: ClickHouseProjectionSchema[];
    disabled: boolean;
    canCreate: boolean;
    canDrop: boolean;
    canClear: boolean;
    canMaterialize: boolean;
    onRequestAction: (action: ClickHouseTableObjectActionDraft) => void;
}

const EMPTY_PROJECTION_DRAFT: ClickHouseProjectionCreateDraft = {
    name: "",
    query: "",
};

function blockers(projection: ClickHouseProjectionSchema): string {
    return projection.editability.blockers
        .map((blocker) => blocker.message)
        .join("；");
}

export const ClickHouseProjectionsEdit: FC<ClickHouseProjectionsEditProps> = ({
    projections,
    disabled,
    canCreate,
    canDrop,
    canClear,
    canMaterialize,
    onRequestAction,
}) => {
    const [draft, setDraft] = useState<ClickHouseProjectionCreateDraft>(
        EMPTY_PROJECTION_DRAFT,
    );
    const createDisabled =
        disabled ||
        !canCreate ||
        draft.name.trim().length === 0 ||
        draft.query.trim().length === 0;

    const requestExistingAction = (
        projection: ClickHouseProjectionSchema,
        operation: "drop" | "clear" | "materialize",
    ): void => {
        onRequestAction({
            objectKind: "projection",
            operation,
            name: projection.name,
            definition: null,
        });
    };

    return (
        <div className="flex flex-col gap-4">
            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3">
                    <h3 className="text-sm font-medium">Create Projection</h3>
                    <p className="text-xs text-muted-foreground">
                        创建一个受控 SELECT projection；已有对象不支持原地修改，定义变更需显式 Drop 后重新 Create。
                    </p>
                </div>
                <div className="grid gap-3 xl:grid-cols-[minmax(12rem,0.35fr)_minmax(24rem,1fr)_auto] xl:items-end">
                    <Field>
                        <FieldLabel>Name</FieldLabel>
                        <Input
                            name="name"
                            value={draft.name}
                            disabled={disabled || !canCreate}
                            placeholder="by_tenant"
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    name: event.target.value,
                                }))
                            }
                        />
                    </Field>
                    <Field>
                        <FieldLabel>Query</FieldLabel>
                        <Textarea
                            name="query"
                            value={draft.query}
                            disabled={disabled || !canCreate}
                            placeholder="SELECT tenant_id, count() GROUP BY tenant_id"
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    query: event.target.value,
                                }))
                            }
                        />
                    </Field>
                    <Button
                        type="button"
                        size="sm"
                        disabled={createDisabled}
                        onClick={() =>
                            onRequestAction({
                                objectKind: "projection",
                                operation: "create",
                                name: draft.name.trim(),
                                definition: {
                                    name: draft.name.trim(),
                                    query: draft.query.trim(),
                                },
                            })
                        }
                    >
                        <Plus data-icon="inline-start" />
                        Create
                    </Button>
                </div>
                {!canCreate && (
                    <p className="mt-3 text-xs text-muted-foreground">
                        当前连接未开放 Projection Create capability。
                    </p>
                )}
            </section>

            <section className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
                <Alert>
                    <Layers3 />
                    <AlertTitle>Projection 全表动作</AlertTitle>
                    <AlertDescription>
                        Materialize、Clear 与 Drop 均作用于整张表，属于可能耗时的破坏性提交；每次执行前都会生成新预览并要求确认。
                    </AlertDescription>
                </Alert>
                {projections.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        远端表没有 Projection 对象。
                    </p>
                ) : (
                    <div className="space-y-2">
                        {projections.map((projection) => {
                            const editable =
                                projection.editability.mode === "editable" &&
                                projection.editability.blockers.length === 0;
                            const hasActions =
                                canDrop || canClear || canMaterialize;
                            return (
                                <div
                                    key={projection.name}
                                    className="flex flex-col gap-2 rounded-md border bg-background p-3"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1 font-mono text-sm font-medium">
                                            {projection.name}
                                        </span>
                                        {editable && canMaterialize && (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={disabled}
                                                title="整表提交 Materialize Projection；可能长时间运行"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        projection,
                                                        "materialize",
                                                    )
                                                }
                                            >
                                                <RefreshCcw data-icon="inline-start" />
                                                Materialize
                                            </Button>
                                        )}
                                        {editable && canClear && (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={disabled}
                                                title="整表提交 Clear Projection；可能清除已物化数据"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        projection,
                                                        "clear",
                                                    )
                                                }
                                            >
                                                <Eraser data-icon="inline-start" />
                                                Clear
                                            </Button>
                                        )}
                                        {editable && canDrop && (
                                            <Button
                                                type="button"
                                                variant="destructive"
                                                size="sm"
                                                disabled={disabled}
                                                title="破坏性删除 Projection 定义"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        projection,
                                                        "drop",
                                                    )
                                                }
                                            >
                                                <Trash2 data-icon="inline-start" />
                                                Drop
                                            </Button>
                                        )}
                                    </div>
                                    <pre className="whitespace-pre-wrap wrap-break-word rounded-sm bg-muted/40 p-2 font-mono text-xs">
                                        {projection.query || "未定义"}
                                    </pre>
                                    {!editable && (
                                        <p className="text-xs text-muted-foreground">
                                            {blockers(projection) ||
                                                "该 Projection 不能被无损识别，保持只读。"}
                                        </p>
                                    )}
                                    {editable && !hasActions && (
                                        <p className="text-xs text-muted-foreground">
                                            当前连接未开放 Projection 对象动作。
                                        </p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
};
