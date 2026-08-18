import type { FC } from "react";
import { Eraser, RefreshCcw } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
    ClickHouseColumnActionDraft,
    ClickHouseTableEditDraft,
} from "@/types/clickhouse-table-design";

import { cloneClickHouseTableEditDraft } from "../clickhouse-table-edit-draft";
import type { ClickHouseEditValidationIssue } from "../clickhouse-table-edit-validation";
import { ClickHouseColumnsCreate } from "./clickhouse-columns-create";

export interface ClickHouseEditSectionProps {
    draft: ClickHouseTableEditDraft;
    issues: readonly ClickHouseEditValidationIssue[];
    disabled: boolean;
    onChange: (draft: ClickHouseTableEditDraft) => void;
}

interface ClickHouseColumnsEditProps extends ClickHouseEditSectionProps {
    canClearColumn: boolean;
    canMaterializeColumn: boolean;
    onColumnAction: (action: ClickHouseColumnActionDraft) => void;
}

export const ClickHouseColumnsEdit: FC<ClickHouseColumnsEditProps> = ({
    draft,
    issues,
    disabled,
    canClearColumn,
    canMaterializeColumn,
    onChange,
    onColumnAction,
}) => {
    const storedColumns = draft.baseline.columns.filter(
        (column) =>
            column.editability.mode === "editable" &&
            column.editability.blockers.length === 0 &&
            column.defaultKind !== "alias" &&
            column.defaultKind !== "ephemeral",
    );

    return (
        <div className="flex flex-col gap-4">
            {(canClearColumn || canMaterializeColumn) && (
                <section className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs">
                    <Alert>
                        <RefreshCcw />
                        <AlertTitle>整列数据动作</AlertTitle>
                        <AlertDescription>
                            CLEAR 与 MATERIALIZE 作用于整张表中的指定存储列，可能触发后台数据重写；每次操作都会重新预览并要求确认。
                        </AlertDescription>
                    </Alert>
                    <div className="flex flex-col gap-2">
                        {storedColumns.map((column) => (
                            <div
                                key={column.name}
                                className="flex flex-wrap items-center gap-2 rounded-md border bg-background p-2"
                            >
                                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                    {column.name}
                                </span>
                                <Badge variant="secondary">
                                    {column.defaultKind === "none"
                                        ? "STORED"
                                        : column.defaultKind.toUpperCase()}
                                </Badge>
                                {canClearColumn && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={disabled}
                                        onClick={() =>
                                            onColumnAction({
                                                action: "clear",
                                                columnName: column.name,
                                            })
                                        }
                                    >
                                        <Eraser data-icon="inline-start" />
                                        CLEAR
                                    </Button>
                                )}
                                {canMaterializeColumn && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={disabled}
                                        onClick={() =>
                                            onColumnAction({
                                                action: "materialize",
                                                columnName: column.name,
                                            })
                                        }
                                    >
                                        <RefreshCcw data-icon="inline-start" />
                                        MATERIALIZE
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}
            <ClickHouseColumnsCreate
                draft={draft.table}
                issues={issues.map((issue) => ({
                    ...issue,
                    code: "edit_validation",
                }))}
                disabled={disabled}
                onChange={(table) =>
                    onChange(
                        cloneClickHouseTableEditDraft({ ...draft, table }),
                    )
                }
            />
        </div>
    );
};
