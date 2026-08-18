import {
    AlertTriangle,
    Database,
    RefreshCw,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { TableSchemaDraft } from "@/types/table-design";

import type { TableDesignResolvedContext } from "./table-design-utils";
import type { TableDesignValidationIssue } from "./validation/table-design-validation";

interface TableDesignHeaderProps {
    mode: "create" | "edit";
    driverName: string;
    draft: TableSchemaDraft;
    context: TableDesignResolvedContext;
    isDirty: boolean;
    hasDestructivePreview: boolean;
    validationIssues: TableDesignValidationIssue[];
    isRefreshing: boolean;
    onTableNameChange: (value: string) => void;
    onRefresh: () => void;
}

export function TableDesignHeader({
    mode,
    driverName,
    draft,
    context,
    isDirty,
    hasDestructivePreview,
    validationIssues,
    isRefreshing,
    onTableNameChange,
    onRefresh,
}: TableDesignHeaderProps) {
    const errors = validationIssues.filter((issue) => issue.severity === "error");
    const warnings = validationIssues.filter((issue) => issue.severity === "warning");

    return (
        <div className="flex shrink-0 items-center gap-3 border-b bg-background px-3 py-2">
            <Database className="size-4 text-muted-foreground" />
            <Input
                value={draft.basics.tableName}
                onChange={(event) => onTableNameChange(event.target.value)}
                placeholder={mode === "create" ? "新表名称" : "表名"}
                className="h-8 w-56"
            />
            <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{driverName}</span>
                <span className="mx-2">/</span>
                <span>{context.contextLabel}</span>
                <span className="mx-2">/</span>
                <span>{context.schemaDisplay}</span>
            </div>
            <div className="flex items-center gap-1 text-xs">
                <span
                    className={cn(
                        "rounded border px-1.5 py-0.5",
                        isDirty
                            ? "border-sky-500/40 text-sky-700 dark:text-sky-300"
                        : "text-muted-foreground",
                    )}
                >
                    {isDirty ? "已修改" : "未修改"}
                </span>
                {errors.length > 0 && (
                    <ValidationIssueBadge
                        label={`${errors.length} 错误`}
                        title="校验错误"
                        issues={errors}
                        className="border-destructive/40 text-destructive"
                    />
                )}
                {warnings.length > 0 && (
                    <ValidationIssueBadge
                        label={`${warnings.length} 警告`}
                        title="校验警告"
                        issues={warnings}
                        className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                    />
                )}
                {hasDestructivePreview && (
                    <span className="inline-flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-destructive">
                        <AlertTriangle className="size-3" />
                        破坏性
                    </span>
                )}
            </div>
            {mode === "edit" && (
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={isRefreshing}
                    onClick={onRefresh}
                    title="刷新结构"
                >
                    <RefreshCw className="size-4" />
                </Button>
            )}
        </div>
    );
}

function ValidationIssueBadge({
    label,
    title,
    issues,
    className,
}: {
    label: string;
    title: string;
    issues: TableDesignValidationIssue[];
    className: string;
}) {
    return (
        <HoverCard>
            <HoverCardTrigger
                delay={120}
                closeDelay={80}
                render={
                    <span
                    className={cn(
                        "inline-flex cursor-default rounded border px-1.5 py-0.5",
                        className,
                    )}
                    tabIndex={0}
                >
                    {label}
                </span>
                }
            />
            <HoverCardContent align="end" className="w-80 p-0">
                <div className="border-b px-3 py-2 text-xs font-medium">{title}</div>
                <ul className="max-h-72 space-y-1 overflow-auto p-2">
                    {issues.map((issue, index) => (
                        <li
                            key={`${issue.scope}-${issue.rowId ?? "table"}-${issue.field ?? "field"}-${index}`}
                            className="rounded-md px-2 py-1.5 text-xs leading-5 text-muted-foreground"
                        >
                            <span className="mr-2 font-medium text-foreground">
                                {formatIssueScope(issue)}
                            </span>
                            {issue.message}
                        </li>
                    ))}
                </ul>
            </HoverCardContent>
        </HoverCard>
    );
}

function formatIssueScope(issue: TableDesignValidationIssue): string {
    const scopeLabel: Record<TableDesignValidationIssue["scope"], string> = {
        table: "表",
        column: "列",
        index: "索引",
        constraint: "约束",
        partition: "分区",
    };

    return issue.field
        ? `${scopeLabel[issue.scope]} / ${issue.field}`
        : scopeLabel[issue.scope];
}
