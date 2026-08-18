import type { FC } from "react";
import {
    ArrowDown,
    ArrowUp,
    Copy,
    Plus,
    Trash2,
} from "lucide-react";

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
import type {
    ClickHouseCodecDraft,
    ClickHouseColumnCreateDraft,
    ClickHouseTableCreateDraft,
} from "@/types/clickhouse-table-design";
import type { ClickHouseColumnDefaultKind } from "@/types/ipc";

import {
    cloneClickHouseTableCreateDraft,
    createClickHouseTableDraft,
} from "../clickhouse-table-create-draft";
import type { ClickHouseCreateValidationIssue } from "../clickhouse-table-create-validation";

interface ClickHouseColumnsCreateProps {
    draft: ClickHouseTableCreateDraft;
    issues: readonly ClickHouseCreateValidationIssue[];
    disabled: boolean;
    onChange: (draft: ClickHouseTableCreateDraft) => void;
}

const DEFAULT_KINDS: Array<{
    value: ClickHouseColumnDefaultKind;
    label: string;
}> = [
    { value: "none", label: "无" },
    { value: "default", label: "DEFAULT" },
    { value: "materialized", label: "MATERIALIZED" },
    { value: "alias", label: "ALIAS" },
    { value: "ephemeral", label: "EPHEMERAL" },
];

const CODEC_NAMES = [
    "LZ4",
    "ZSTD",
    "Delta",
    "DoubleDelta",
    "Gorilla",
    "T64",
    "FPC",
] as const;

function newId(prefix: string): string {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function errorsForPath(
    issues: readonly ClickHouseCreateValidationIssue[],
    path: string,
): Array<{ message: string }> {
    return issues
        .filter((issue) => issue.path === path)
        .map((issue) => ({ message: issue.message }));
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
    if (to < 0 || to >= items.length) return items;
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    return next;
}

export const ClickHouseColumnsCreate: FC<ClickHouseColumnsCreateProps> = ({
    draft,
    issues,
    disabled,
    onChange,
}) => {
    const updateColumn = (
        columnIndex: number,
        update: (column: ClickHouseColumnCreateDraft) => void,
    ): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        const column = next.columns[columnIndex];
        if (!column) return;
        update(column);
        onChange(next);
    };

    const addColumn = (): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        next.columns.push(createClickHouseTableDraft("").columns[0]);
        onChange(next);
    };

    const duplicateColumn = (columnIndex: number): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        const source = next.columns[columnIndex];
        if (!source) return;
        const duplicate: ClickHouseColumnCreateDraft = {
            ...source,
            id: newId("column"),
            name: source.name ? `${source.name}_copy` : "",
            codecs: source.codecs.map((codec) => ({
                ...codec,
                id: newId("codec"),
                arguments: [...codec.arguments],
            })),
        };
        next.columns.splice(columnIndex + 1, 0, duplicate);
        onChange(next);
    };

    const removeColumn = (columnIndex: number): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        next.columns.splice(columnIndex, 1);
        onChange(next);
    };

    const moveColumn = (columnIndex: number, offset: -1 | 1): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        next.columns = moveItem(
            next.columns,
            columnIndex,
            columnIndex + offset,
        );
        onChange(next);
    };

    const addCodec = (columnIndex: number): void => {
        updateColumn(columnIndex, (column) => {
            column.codecs.push({
                id: newId("codec"),
                name: "ZSTD",
                arguments: [],
            });
        });
    };

    const updateCodec = (
        columnIndex: number,
        codecIndex: number,
        update: (codec: ClickHouseCodecDraft) => void,
    ): void => {
        updateColumn(columnIndex, (column) => {
            const codec = column.codecs[codecIndex];
            if (codec) update(codec);
        });
    };

    const removeCodec = (columnIndex: number, codecIndex: number): void => {
        updateColumn(columnIndex, (column) => {
            column.codecs.splice(codecIndex, 1);
        });
    };

    const moveCodec = (
        columnIndex: number,
        codecIndex: number,
        offset: -1 | 1,
    ): void => {
        updateColumn(columnIndex, (column) => {
            column.codecs = moveItem(
                column.codecs,
                codecIndex,
                codecIndex + offset,
            );
        });
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <h3 className="text-sm font-medium">Columns</h3>
                    <p className="text-xs text-muted-foreground">
                        按 DDL 顺序定义列、默认表达式、Codec、TTL 与注释。
                    </p>
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={addColumn}
                >
                    <Plus data-icon="inline-start" />
                    添加列
                </Button>
            </div>
            <FieldError errors={errorsForPath(issues, "columns")} />

            {draft.columns.map((column, columnIndex) => {
                const path = `columns.${columnIndex}`;
                return (
                    <section
                        key={column.id}
                        className="rounded-lg border bg-card p-3 shadow-xs"
                    >
                        <div className="mb-3 flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {column.name || `未命名列 ${columnIndex + 1}`}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={disabled || columnIndex === 0}
                                onClick={() => moveColumn(columnIndex, -1)}
                                aria-label="上移列"
                            >
                                <ArrowUp />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={
                                    disabled ||
                                    columnIndex === draft.columns.length - 1
                                }
                                onClick={() => moveColumn(columnIndex, 1)}
                                aria-label="下移列"
                            >
                                <ArrowDown />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={disabled}
                                onClick={() => duplicateColumn(columnIndex)}
                                aria-label="复制列"
                            >
                                <Copy />
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                disabled={disabled}
                                onClick={() => removeColumn(columnIndex)}
                                aria-label="删除列"
                            >
                                <Trash2 />
                            </Button>
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2">
                            <Field
                                data-invalid={
                                    errorsForPath(issues, `${path}.name`).length >
                                    0
                                }
                            >
                                <FieldLabel>列名</FieldLabel>
                                <Input
                                    value={column.name}
                                    disabled={disabled}
                                    aria-invalid={
                                        errorsForPath(issues, `${path}.name`)
                                            .length > 0
                                    }
                                    onChange={(event) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.name = event.target.value;
                                        })
                                    }
                                />
                                <FieldError
                                    errors={errorsForPath(
                                        issues,
                                        `${path}.name`,
                                    )}
                                />
                            </Field>
                            <Field
                                data-invalid={
                                    errorsForPath(issues, `${path}.typeName`)
                                        .length > 0
                                }
                            >
                                <FieldLabel>类型表达式</FieldLabel>
                                <Input
                                    value={column.typeName}
                                    placeholder="UInt64 / Nullable(String)"
                                    disabled={disabled}
                                    aria-invalid={
                                        errorsForPath(
                                            issues,
                                            `${path}.typeName`,
                                        ).length > 0
                                    }
                                    onChange={(event) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.typeName = event.target.value;
                                        })
                                    }
                                />
                                <FieldError
                                    errors={errorsForPath(
                                        issues,
                                        `${path}.typeName`,
                                    )}
                                />
                            </Field>
                            <Field>
                                <FieldLabel>默认值类型</FieldLabel>
                                <Select
                                    value={column.defaultKind}
                                    items={DEFAULT_KINDS}
                                    disabled={disabled}
                                    onValueChange={(value) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.defaultKind =
                                                value as ClickHouseColumnDefaultKind;
                                            if (value === "none") {
                                                current.defaultExpression = "";
                                            }
                                        })
                                    }
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {DEFAULT_KINDS.map((kind) => (
                                            <SelectItem
                                                key={kind.value}
                                                value={kind.value}
                                            >
                                                {kind.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field
                                data-invalid={
                                    errorsForPath(
                                        issues,
                                        `${path}.defaultExpression`,
                                    ).length > 0
                                }
                            >
                                <FieldLabel>默认表达式</FieldLabel>
                                <Input
                                    value={column.defaultExpression}
                                    placeholder="now64(3)"
                                    disabled={
                                        disabled || column.defaultKind === "none"
                                    }
                                    aria-invalid={
                                        errorsForPath(
                                            issues,
                                            `${path}.defaultExpression`,
                                        ).length > 0
                                    }
                                    onChange={(event) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.defaultExpression =
                                                event.target.value;
                                        })
                                    }
                                />
                                <FieldError
                                    errors={errorsForPath(
                                        issues,
                                        `${path}.defaultExpression`,
                                    )}
                                />
                            </Field>
                        </div>

                        <div className="mt-3 rounded-md border bg-muted/20 p-2">
                            <div className="mb-2 flex items-center justify-between">
                                <span className="text-xs font-medium">Codecs</span>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={disabled}
                                    onClick={() => addCodec(columnIndex)}
                                >
                                    <Plus data-icon="inline-start" />
                                    添加 Codec
                                </Button>
                            </div>
                            {column.codecs.length === 0 ? (
                                <p className="text-xs text-muted-foreground">
                                    未显式设置 Codec。
                                </p>
                            ) : (
                                <div className="space-y-2">
                                    {column.codecs.map((codec, codecIndex) => {
                                        const codecPath = `${path}.codecs.${codecIndex}`;
                                        return (
                                            <div
                                                key={codec.id}
                                                className="rounded-md border bg-background p-2"
                                            >
                                                <div className="flex items-start gap-2">
                                                    <Field className="min-w-40 flex-1">
                                                        <FieldLabel>
                                                            Codec
                                                        </FieldLabel>
                                                        <Select
                                                            value={codec.name}
                                                            disabled={disabled}
                                                            onValueChange={(value) => {
                                                                if (value == null) return;
                                                                updateCodec(
                                                                    columnIndex,
                                                                    codecIndex,
                                                                    (current) => {
                                                                        current.name =
                                                                            value;
                                                                    },
                                                                );
                                                            }}
                                                        >
                                                            <SelectTrigger className="w-full">
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                {CODEC_NAMES.map(
                                                                    (name) => (
                                                                        <SelectItem
                                                                            key={name}
                                                                            value={name}
                                                                        >
                                                                            {name}
                                                                        </SelectItem>
                                                                    ),
                                                                )}
                                                            </SelectContent>
                                                        </Select>
                                                        <FieldError
                                                            errors={errorsForPath(
                                                                issues,
                                                                `${codecPath}.name`,
                                                            )}
                                                        />
                                                    </Field>
                                                    <div className="flex gap-1 pt-6">
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            disabled={
                                                                disabled ||
                                                                codecIndex === 0
                                                            }
                                                            onClick={() =>
                                                                moveCodec(
                                                                    columnIndex,
                                                                    codecIndex,
                                                                    -1,
                                                                )
                                                            }
                                                            aria-label="上移 Codec"
                                                        >
                                                            <ArrowUp />
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            disabled={
                                                                disabled ||
                                                                codecIndex ===
                                                                    column.codecs
                                                                        .length -
                                                                        1
                                                            }
                                                            onClick={() =>
                                                                moveCodec(
                                                                    columnIndex,
                                                                    codecIndex,
                                                                    1,
                                                                )
                                                            }
                                                            aria-label="下移 Codec"
                                                        >
                                                            <ArrowDown />
                                                        </Button>
                                                        <Button
                                                            type="button"
                                                            variant="ghost"
                                                            size="icon-sm"
                                                            disabled={disabled}
                                                            onClick={() =>
                                                                removeCodec(
                                                                    columnIndex,
                                                                    codecIndex,
                                                                )
                                                            }
                                                            aria-label="删除 Codec"
                                                        >
                                                            <Trash2 />
                                                        </Button>
                                                    </div>
                                                </div>
                                                <div className="mt-2 space-y-2">
                                                    {codec.arguments.map(
                                                        (argument, argumentIndex) => (
                                                            <div
                                                                key={`${codec.id}-argument-${argumentIndex}`}
                                                                className="flex items-start gap-2"
                                                            >
                                                                <Field className="flex-1">
                                                                    <FieldLabel>
                                                                        参数 {argumentIndex + 1}
                                                                    </FieldLabel>
                                                                    <Input
                                                                        value={argument}
                                                                        disabled={disabled}
                                                                        onChange={(event) =>
                                                                            updateCodec(
                                                                                columnIndex,
                                                                                codecIndex,
                                                                                (
                                                                                    current,
                                                                                ) => {
                                                                                    current.arguments[
                                                                                        argumentIndex
                                                                                    ] =
                                                                                        event.target.value;
                                                                                },
                                                                            )
                                                                        }
                                                                    />
                                                                    <FieldError
                                                                        errors={errorsForPath(
                                                                            issues,
                                                                            `${codecPath}.arguments.${argumentIndex}`,
                                                                        )}
                                                                    />
                                                                </Field>
                                                                <Button
                                                                    type="button"
                                                                    variant="ghost"
                                                                    size="icon-sm"
                                                                    className="mt-6"
                                                                    disabled={disabled}
                                                                    onClick={() =>
                                                                        updateCodec(
                                                                            columnIndex,
                                                                            codecIndex,
                                                                            (current) => {
                                                                                current.arguments.splice(
                                                                                    argumentIndex,
                                                                                    1,
                                                                                );
                                                                            },
                                                                        )
                                                                    }
                                                                    aria-label="删除 Codec 参数"
                                                                >
                                                                    <Trash2 />
                                                                </Button>
                                                            </div>
                                                        ),
                                                    )}
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={disabled}
                                                        onClick={() =>
                                                            updateCodec(
                                                                columnIndex,
                                                                codecIndex,
                                                                (current) => {
                                                                    current.arguments.push(
                                                                        "",
                                                                    );
                                                                },
                                                            )
                                                        }
                                                    >
                                                        <Plus data-icon="inline-start" />
                                                        添加参数
                                                    </Button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="mt-3 grid gap-3 xl:grid-cols-2">
                            <Field>
                                <FieldLabel>列 TTL</FieldLabel>
                                <Textarea
                                    value={column.ttlExpression}
                                    placeholder="created_at + INTERVAL 7 DAY"
                                    disabled={disabled}
                                    onChange={(event) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.ttlExpression =
                                                event.target.value;
                                        })
                                    }
                                />
                                <FieldError
                                    errors={errorsForPath(
                                        issues,
                                        `${path}.ttlExpression`,
                                    )}
                                />
                            </Field>
                            <Field>
                                <FieldLabel>列注释</FieldLabel>
                                <Textarea
                                    value={column.comment}
                                    disabled={disabled}
                                    onChange={(event) =>
                                        updateColumn(columnIndex, (current) => {
                                            current.comment = event.target.value;
                                        })
                                    }
                                />
                            </Field>
                        </div>
                    </section>
                );
            })}
        </div>
    );
};
