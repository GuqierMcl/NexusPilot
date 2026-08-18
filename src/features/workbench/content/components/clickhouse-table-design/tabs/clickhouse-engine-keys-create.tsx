import type { FC } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";

import { cloneClickHouseTableCreateDraft } from "../clickhouse-table-create-draft";
import type { ClickHouseCreateValidationIssue } from "../clickhouse-table-create-validation";

interface ClickHouseEngineKeysCreateProps {
    draft: ClickHouseTableCreateDraft;
    issues: readonly ClickHouseCreateValidationIssue[];
    disabled: boolean;
    onChange: (draft: ClickHouseTableCreateDraft) => void;
}

interface EngineProfile {
    family: string;
    minArguments: number;
    maxArguments: number;
    argumentLabels: string[];
}

const ENGINE_PROFILES: EngineProfile[] = [
    { family: "MergeTree", minArguments: 0, maxArguments: 0, argumentLabels: [] },
    {
        family: "ReplacingMergeTree",
        minArguments: 0,
        maxArguments: 1,
        argumentLabels: ["version"],
    },
    {
        family: "SummingMergeTree",
        minArguments: 0,
        maxArguments: 1,
        argumentLabels: ["columns"],
    },
    {
        family: "AggregatingMergeTree",
        minArguments: 0,
        maxArguments: 0,
        argumentLabels: [],
    },
    {
        family: "CollapsingMergeTree",
        minArguments: 1,
        maxArguments: 1,
        argumentLabels: ["sign"],
    },
    {
        family: "VersionedCollapsingMergeTree",
        minArguments: 2,
        maxArguments: 2,
        argumentLabels: ["sign", "version"],
    },
];

function errorsForPath(
    issues: readonly ClickHouseCreateValidationIssue[],
    path: string,
): Array<{ message: string }> {
    return issues
        .filter((issue) => issue.path === path)
        .map((issue) => ({ message: issue.message }));
}

export const ClickHouseEngineKeysCreate: FC<ClickHouseEngineKeysCreateProps> = ({
    draft,
    issues,
    disabled,
    onChange,
}) => {
    const profile =
        ENGINE_PROFILES.find(
            (candidate) => candidate.family === draft.engineFamily,
        ) ?? ENGINE_PROFILES[0];

    const changeEngine = (family: string): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        const nextProfile =
            ENGINE_PROFILES.find((candidate) => candidate.family === family) ??
            ENGINE_PROFILES[0];
        next.engineFamily = family;
        next.engineArguments = next.engineArguments.slice(
            0,
            nextProfile.maxArguments,
        );
        while (next.engineArguments.length < nextProfile.minArguments) {
            next.engineArguments.push("");
        }
        onChange(next);
    };

    const updateExpression = (
        field:
            | "orderBy"
            | "partitionBy"
            | "primaryKey"
            | "sampleBy",
        value: string,
    ): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        next[field] = value;
        onChange(next);
    };

    return (
        <div className="flex flex-col gap-4">
            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3">
                    <h3 className="text-sm font-medium">Engine</h3>
                    <p className="text-xs text-muted-foreground">
                        当前仅支持经过兼容性验证的非复制 MergeTree 系列表引擎。
                    </p>
                </div>
                <Field data-invalid={errorsForPath(issues, "engineFamily").length > 0}>
                    <FieldLabel>Engine family</FieldLabel>
                    <Select
                        value={draft.engineFamily}
                        disabled={disabled}
                        onValueChange={(family) => {
                            if (family != null) changeEngine(family);
                        }}
                    >
                        <SelectTrigger className="w-full max-w-md">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {ENGINE_PROFILES.map((engine) => (
                                <SelectItem
                                    key={engine.family}
                                    value={engine.family}
                                >
                                    {engine.family}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FieldError errors={errorsForPath(issues, "engineFamily")} />
                </Field>

                <div className="mt-3 space-y-3">
                    {draft.engineArguments.map((argument, argumentIndex) => (
                        <div
                            key={`engine-argument-${argumentIndex}`}
                            className="flex items-start gap-2"
                        >
                            <Field className="max-w-2xl flex-1">
                                <FieldLabel>
                                    {profile.argumentLabels[argumentIndex] ??
                                        `参数 ${argumentIndex + 1}`}
                                </FieldLabel>
                                <Input
                                    value={argument}
                                    disabled={disabled}
                                    placeholder="列名或单一表达式"
                                    onChange={(event) => {
                                        const next =
                                            cloneClickHouseTableCreateDraft(
                                                draft,
                                            );
                                        next.engineArguments[argumentIndex] =
                                            event.target.value;
                                        onChange(next);
                                    }}
                                />
                                <FieldError
                                    errors={errorsForPath(
                                        issues,
                                        `engineArguments.${argumentIndex}`,
                                    )}
                                />
                            </Field>
                            {argumentIndex >= profile.minArguments && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="mt-6"
                                    disabled={disabled}
                                    onClick={() => {
                                        const next =
                                            cloneClickHouseTableCreateDraft(
                                                draft,
                                            );
                                        next.engineArguments.splice(
                                            argumentIndex,
                                            1,
                                        );
                                        onChange(next);
                                    }}
                                    aria-label="删除可选引擎参数"
                                >
                                    <Trash2 />
                                </Button>
                            )}
                        </div>
                    ))}
                    {draft.engineArguments.length < profile.maxArguments && (
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={disabled}
                            onClick={() => {
                                const next = cloneClickHouseTableCreateDraft(draft);
                                next.engineArguments.push("");
                                onChange(next);
                            }}
                        >
                            <Plus data-icon="inline-start" />
                            添加可选引擎参数
                        </Button>
                    )}
                </div>
            </section>

            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3">
                    <h3 className="text-sm font-medium">Keys</h3>
                    <p className="text-xs text-muted-foreground">
                        ORDER BY 必填；其余 key clauses 可按目标表语义显式设置。
                    </p>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                    {(
                        [
                            ["orderBy", "ORDER BY", "tuple()"],
                            [
                                "partitionBy",
                                "PARTITION BY",
                                "toYYYYMM(created_at)",
                            ],
                            ["primaryKey", "PRIMARY KEY", "id"],
                            ["sampleBy", "SAMPLE BY", "cityHash64(id)"],
                        ] as const
                    ).map(([field, label, placeholder]) => (
                        <Field
                            key={field}
                            data-invalid={
                                errorsForPath(issues, field).length > 0
                            }
                        >
                            <FieldLabel>{label}</FieldLabel>
                            <Textarea
                                value={draft[field]}
                                placeholder={placeholder}
                                disabled={disabled}
                                aria-invalid={
                                    errorsForPath(issues, field).length > 0
                                }
                                onChange={(event) =>
                                    updateExpression(field, event.target.value)
                                }
                            />
                            <FieldError errors={errorsForPath(issues, field)} />
                        </Field>
                    ))}
                </div>
            </section>
        </div>
    );
};
