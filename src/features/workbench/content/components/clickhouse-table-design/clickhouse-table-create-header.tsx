import type { FC } from "react";
import { TableProperties } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SchemaDesignOperationState } from "@/store";
import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";

import type { ClickHouseCreateValidationIssue } from "./clickhouse-table-create-validation";

interface ClickHouseTableCreateHeaderProps {
    draft: ClickHouseTableCreateDraft;
    issues: readonly ClickHouseCreateValidationIssue[];
    isDirty: boolean;
    operationState: SchemaDesignOperationState;
    disabled: boolean;
    onTableNameChange: (value: string) => void;
}

const OPERATION_LABELS: Record<SchemaDesignOperationState, string> = {
    idle: "等待预览",
    previewing: "生成预览中",
    previewReady: "预览已就绪",
    applying: "创建中",
    backgroundRunning: "后台工作中",
    submitted: "已提交",
    partiallyApplied: "部分应用",
    conflict: "远端已变化",
    clusterDrift: "集群已漂移",
    outcomeUnknown: "结果待确认",
};

export const ClickHouseTableCreateHeader: FC<
    ClickHouseTableCreateHeaderProps
> = ({
    draft,
    issues,
    isDirty,
    operationState,
    disabled,
    onTableNameChange,
}) => {
    const nameErrors = issues
        .filter((issue) => issue.path === "name")
        .map((issue) => ({ message: issue.message }));

    return (
        <div className="flex shrink-0 items-start gap-3 border-b bg-background px-3 py-2">
            <TableProperties className="mt-2 size-4 shrink-0 text-muted-foreground" />
            <Field
                className="max-w-sm"
                data-invalid={nameErrors.length > 0}
            >
                <Input
                    value={draft.name}
                    placeholder="新 ClickHouse 表名称"
                    disabled={disabled}
                    aria-invalid={nameErrors.length > 0}
                    onChange={(event) => onTableNameChange(event.target.value)}
                />
                <FieldError errors={nameErrors} />
            </Field>
            <div className="min-w-0 flex-1 pt-1 text-xs text-muted-foreground">
                <div className="truncate font-medium text-foreground">
                    ClickHouse / {draft.database || "目标数据库未确定"}
                </div>
                <div className="truncate">
                    Columns · Engine & Keys · TTL & Settings
                </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-1">
                <Badge variant="outline">ClickHouse</Badge>
                <Badge variant="secondary">Create</Badge>
                <Badge variant={isDirty ? "default" : "outline"}>
                    {isDirty ? "已修改" : "未修改"}
                </Badge>
                {issues.length > 0 && (
                    <Badge variant="destructive">{issues.length} 个错误</Badge>
                )}
                <Badge
                    variant={
                        operationState === "outcomeUnknown"
                            ? "destructive"
                            : "outline"
                    }
                >
                    {OPERATION_LABELS[operationState]}
                </Badge>
            </div>
        </div>
    );
};
