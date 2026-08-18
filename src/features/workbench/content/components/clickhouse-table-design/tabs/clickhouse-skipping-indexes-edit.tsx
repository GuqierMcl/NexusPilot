import { useState, type FC } from "react";
import { Eraser, Plus, RefreshCcw, ScanSearch, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import type {
    ClickHouseSkippingIndexCreateDraft,
    ClickHouseTableObjectActionDraft,
} from "@/types/clickhouse-table-design";
import type { ClickHouseSkippingIndexSchema } from "@/types/ipc";

interface ClickHouseSkippingIndexesEditProps {
    indexes: ClickHouseSkippingIndexSchema[];
    disabled: boolean;
    canCreate: boolean;
    canDrop: boolean;
    canClear: boolean;
    canMaterialize: boolean;
    onRequestAction: (action: ClickHouseTableObjectActionDraft) => void;
}

type IndexType = ClickHouseSkippingIndexCreateDraft["indexType"];

interface IndexTypeProfile {
    type: IndexType;
    argumentLabels: string[];
    initialArguments: string[];
}

const INDEX_TYPE_PROFILES: IndexTypeProfile[] = [
    { type: "minmax", argumentLabels: [], initialArguments: [] },
    {
        type: "set",
        argumentLabels: ["max_rows"],
        initialArguments: ["0"],
    },
    {
        type: "bloom_filter",
        argumentLabels: ["false_positive（可选）"],
        initialArguments: [],
    },
    {
        type: "ngrambf_v1",
        argumentLabels: [
            "ngram_size",
            "filter_bytes",
            "hash_functions",
            "random_seed",
        ],
        initialArguments: ["3", "256", "2", "0"],
    },
    {
        type: "tokenbf_v1",
        argumentLabels: ["filter_bytes", "hash_functions", "random_seed"],
        initialArguments: ["256", "2", "0"],
    },
];

const EMPTY_INDEX_DRAFT: ClickHouseSkippingIndexCreateDraft = {
    name: "",
    expression: "",
    indexType: "minmax",
    typeArguments: [],
    granularity: "1",
};

function blockers(index: ClickHouseSkippingIndexSchema): string {
    return index.editability.blockers
        .map((blocker) => blocker.message)
        .join("；");
}

function formatIndexType(index: ClickHouseSkippingIndexSchema): string {
    return index.typeArguments.length > 0
        ? `${index.indexType}(${index.typeArguments.join(", ")})`
        : index.indexType;
}

export const ClickHouseSkippingIndexesEdit: FC<
    ClickHouseSkippingIndexesEditProps
> = ({
    indexes,
    disabled,
    canCreate,
    canDrop,
    canClear,
    canMaterialize,
    onRequestAction,
}) => {
    const [draft, setDraft] =
        useState<ClickHouseSkippingIndexCreateDraft>(EMPTY_INDEX_DRAFT);
    const profile =
        INDEX_TYPE_PROFILES.find(
            (candidate) => candidate.type === draft.indexType,
        ) ?? INDEX_TYPE_PROFILES[0]!;
    const createDisabled =
        disabled ||
        !canCreate ||
        draft.name.trim().length === 0 ||
        draft.expression.trim().length === 0 ||
        draft.granularity.trim().length === 0;

    const requestExistingAction = (
        index: ClickHouseSkippingIndexSchema,
        operation: "drop" | "clear" | "materialize",
    ): void => {
        onRequestAction({
            objectKind: "index",
            operation,
            name: index.name,
            definition: null,
        });
    };

    return (
        <div className="flex flex-col gap-4">
            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3">
                    <h3 className="text-sm font-medium">
                        Create Data-skipping Index
                    </h3>
                    <p className="text-xs text-muted-foreground">
                        仅开放经过验证的五类索引；已有对象不支持原地修改，定义变更需显式 Drop 后重新 Create。
                    </p>
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                    <Field>
                        <FieldLabel>Name</FieldLabel>
                        <Input
                            name="name"
                            value={draft.name}
                            disabled={disabled || !canCreate}
                            placeholder="message_bf"
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    name: event.target.value,
                                }))
                            }
                        />
                    </Field>
                    <Field>
                        <FieldLabel>Expression</FieldLabel>
                        <Input
                            name="expression"
                            value={draft.expression}
                            disabled={disabled || !canCreate}
                            placeholder="message"
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    expression: event.target.value,
                                }))
                            }
                        />
                    </Field>
                    <Field>
                        <FieldLabel>Index type</FieldLabel>
                        <Select
                            value={draft.indexType}
                            disabled={disabled || !canCreate}
                            onValueChange={(value) => {
                                const nextProfile = INDEX_TYPE_PROFILES.find(
                                    (candidate) => candidate.type === value,
                                );
                                if (!nextProfile) return;
                                setDraft((current) => ({
                                    ...current,
                                    indexType: nextProfile.type,
                                    typeArguments: [
                                        ...nextProfile.initialArguments,
                                    ],
                                }));
                            }}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {INDEX_TYPE_PROFILES.map((candidate) => (
                                    <SelectItem
                                        key={candidate.type}
                                        value={candidate.type}
                                    >
                                        {candidate.type}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field>
                        <FieldLabel>Granularity</FieldLabel>
                        <Input
                            name="granularity"
                            inputMode="numeric"
                            value={draft.granularity}
                            disabled={disabled || !canCreate}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    granularity: event.target.value,
                                }))
                            }
                        />
                    </Field>
                </div>

                {profile.argumentLabels.length > 0 && (
                    <div className="mt-3 grid gap-3 xl:grid-cols-2">
                        {profile.argumentLabels.map((label, argumentIndex) => (
                            <Field key={`${profile.type}-${label}`}>
                                <FieldLabel>{label}</FieldLabel>
                                <Input
                                    name={`typeArguments.${argumentIndex}`}
                                    value={
                                        draft.typeArguments[argumentIndex] ?? ""
                                    }
                                    disabled={disabled || !canCreate}
                                    placeholder={
                                        profile.type === "bloom_filter"
                                            ? "留空使用服务端默认值"
                                            : undefined
                                    }
                                    onChange={(event) => {
                                        const value = event.target.value;
                                        setDraft((current) => {
                                            if (
                                                current.indexType ===
                                                    "bloom_filter" &&
                                                value.trim().length === 0
                                            ) {
                                                return {
                                                    ...current,
                                                    typeArguments: [],
                                                };
                                            }
                                            const typeArguments = [
                                                ...current.typeArguments,
                                            ];
                                            typeArguments[argumentIndex] = value;
                                            return { ...current, typeArguments };
                                        });
                                    }}
                                />
                            </Field>
                        ))}
                    </div>
                )}

                <div className="mt-4 flex items-center justify-between gap-3">
                    {!canCreate ? (
                        <p className="text-xs text-muted-foreground">
                            当前连接未开放 Data-skipping Index Create capability。
                        </p>
                    ) : (
                        <span />
                    )}
                    <Button
                        type="button"
                        size="sm"
                        disabled={createDisabled}
                        onClick={() =>
                            onRequestAction({
                                objectKind: "index",
                                operation: "create",
                                name: draft.name.trim(),
                                definition: {
                                    ...draft,
                                    name: draft.name.trim(),
                                    expression: draft.expression.trim(),
                                    typeArguments: draft.typeArguments.map(
                                        (argument) => argument.trim(),
                                    ),
                                    granularity: draft.granularity.trim(),
                                },
                            })
                        }
                    >
                        <Plus data-icon="inline-start" />
                        Create
                    </Button>
                </div>
            </section>

            <section className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
                <Alert>
                    <ScanSearch />
                    <AlertTitle>Data-skipping Index 全表动作</AlertTitle>
                    <AlertDescription>
                        Materialize、Clear 与 Drop 均作用于整张表，属于可能耗时的破坏性提交；不接受 IN PARTITION 自由表达式。
                    </AlertDescription>
                </Alert>
                {indexes.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        远端表没有 Data-skipping Index 对象。
                    </p>
                ) : (
                    <div className="space-y-2">
                        {indexes.map((index) => {
                            const editable =
                                index.editability.mode === "editable" &&
                                index.editability.blockers.length === 0;
                            const hasActions =
                                canDrop || canClear || canMaterialize;
                            return (
                                <div
                                    key={index.name}
                                    className="flex flex-col gap-2 rounded-md border bg-background p-3"
                                >
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 flex-1 font-mono text-sm font-medium">
                                            {index.name}
                                        </span>
                                        {editable && canMaterialize && (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={disabled}
                                                title="整表提交 Materialize Index；可能长时间运行"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        index,
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
                                                title="整表提交 Clear Index；可能清除已物化数据"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        index,
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
                                                title="破坏性删除 Data-skipping Index 定义"
                                                onClick={() =>
                                                    requestExistingAction(
                                                        index,
                                                        "drop",
                                                    )
                                                }
                                            >
                                                <Trash2 data-icon="inline-start" />
                                                Drop
                                            </Button>
                                        )}
                                    </div>
                                    <div className="grid gap-2 text-xs md:grid-cols-[minmax(10rem,1fr)_minmax(10rem,0.6fr)_auto]">
                                        <code className="min-w-0 wrap-break-word rounded-sm bg-muted/40 p-2">
                                            {index.expression || "未定义"}
                                        </code>
                                        <code className="min-w-0 wrap-break-word rounded-sm bg-muted/40 p-2">
                                            {formatIndexType(index)}
                                        </code>
                                        <span className="rounded-sm bg-muted/40 p-2 text-muted-foreground">
                                            GRANULARITY {index.granularity ?? "未定义"}
                                        </span>
                                    </div>
                                    {!editable && (
                                        <p className="text-xs text-muted-foreground">
                                            {blockers(index) ||
                                                "该 Index family 不能被无损识别，保持只读。"}
                                        </p>
                                    )}
                                    {editable && !hasActions && (
                                        <p className="text-xs text-muted-foreground">
                                            当前连接未开放 Data-skipping Index 对象动作。
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
