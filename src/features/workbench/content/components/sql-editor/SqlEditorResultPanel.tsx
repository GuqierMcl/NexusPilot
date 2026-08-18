import type { FC } from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Circle,
    Clock3,
    Loader2,
    SkipForward,
} from "lucide-react";

import { RelationalDataTable } from "@/components/data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatIpcError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import type { SqlScriptExecutionBatch, SqlScriptStatementResult } from "@/store";
import type {
    IAppError,
    QueryResult,
    SqlExecutionOutcome,
} from "@/types/ipc";

import { buildSqlExecutionOutcomePresentation } from "./sql-execution-outcome";
import type { RawSqlArtifactOwner } from "./raw-sql-result";
import { RawSqlResultView } from "./RawSqlResultView";
import { buildSqlEditorPagingState } from "./sql-editor-utils";
import { buildSqlScriptResultHeader } from "./sql-script-lifecycle";

interface SqlEditorResultPanelProps {
    result: QueryResult | null;
    outcome?: SqlExecutionOutcome | null;
    error: IAppError | null;
    isExecuting: boolean;
    page: number;
    pageSize: number;
    scriptBatch?: SqlScriptExecutionBatch | null;
    onPreviousPage: () => void;
    onNextPage: () => void;
    onSelectScriptStatement?: (statementId: string) => void;
    rawArtifactOwner?: Omit<RawSqlArtifactOwner, "artifactId"> | null;
    isSavingRawArtifact?: boolean;
    onSaveRawArtifact?(
        input: RawSqlArtifactOwner & { format: string | null },
    ): void;
}

function getScriptStatusLabel(statement: SqlScriptStatementResult): string {
    switch (statement.status) {
        case "pending":
            return "等待";
        case "running":
            return "执行中";
        case "succeeded": {
            const presentation = buildSqlExecutionOutcomePresentation(
                statement.outcome,
                null,
            );
            if (presentation?.kind === "rows") {
                return presentation.result.columns.length > 0
                    ? `${presentation.result.rows.length} 行`
                    : presentation.emptyLabel;
            }
            if (presentation?.kind === "command") {
                return presentation.metricLabel ?? presentation.headline;
            }
            if (presentation?.kind === "raw") {
                return `原始结果 · ${String(presentation.outcome.byteLength)} 字节`;
            }
            return "执行完成";
        }
        case "failed":
            return "失败";
        case "timedOut":
            return "已超时";
        case "canceled":
            return "已取消";
        case "cancelFailed":
            return "取消未确认";
        case "skipped":
            return "已跳过";
    }
}

function getScriptStatusIcon(statement: SqlScriptStatementResult) {
    switch (statement.status) {
        case "running":
            return Loader2;
        case "succeeded":
            return CheckCircle2;
        case "failed":
        case "cancelFailed":
            return AlertCircle;
        case "timedOut":
            return Clock3;
        case "canceled":
            return Circle;
        case "skipped":
            return SkipForward;
        case "pending":
            return Clock3;
    }
}

function formatElapsedMs(elapsedMs: number | null): string | null {
    if (elapsedMs == null) return null;
    if (elapsedMs < 1000) return `${elapsedMs} ms`;
    return `${(elapsedMs / 1000).toFixed(1)} s`;
}

function previewSql(sql: string): string {
    const compact = sql.replace(/\s+/g, " ").trim();
    if (compact.length <= 96) return compact;
    return `${compact.slice(0, 95)}...`;
}

interface ScriptStatementDetailProps {
    statement: SqlScriptStatementResult;
}

const ScriptStatementDetail: FC<ScriptStatementDetailProps> = ({ statement }) => {
    if (statement.status === "pending") {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Clock3 className="size-4" />
                等待执行
            </div>
        );
    }

    if (statement.status === "running") {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                正在执行第 {statement.index} 条 SQL...
            </div>
        );
    }

    if (statement.status === "skipped") {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <SkipForward className="size-4" />
                队列已停止，此语句未执行
            </div>
        );
    }

    if (
        statement.status === "failed" ||
        statement.status === "timedOut" ||
        statement.status === "cancelFailed"
    ) {
        const title =
            statement.status === "timedOut"
                ? `第 ${statement.index} 条 SQL 执行超时`
                : statement.status === "cancelFailed"
                  ? `第 ${statement.index} 条 SQL 取消未确认`
                  : `第 ${statement.index} 条 SQL 执行失败`;
        return (
            <div className="p-3">
                <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertTitle>{title}</AlertTitle>
                    <AlertDescription>
                        {statement.error
                            ? formatIpcError(statement.error)
                            : statement.snapshot?.cancelMessage ??
                              "服务端未返回可确认的终态详情"}
                    </AlertDescription>
                </Alert>
            </div>
        );
    }

    if (statement.status === "canceled") {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Circle className="size-4" />
                {statement.snapshot?.cancelMessage ?? "查询已取消"}
            </div>
        );
    }

    const presentation = buildSqlExecutionOutcomePresentation(
        statement.outcome,
        null,
    );

    if (!presentation) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Circle className="size-4" />
                没有结果
            </div>
        );
    }

    if (presentation.kind === "command") {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500" />
                    <span className="text-foreground">
                        {presentation.headline}
                    </span>
                </div>
                {presentation.metricLabel ? (
                    <div>{presentation.metricLabel}</div>
                ) : null}
                {presentation.warning ? (
                    <Alert className="max-w-2xl">
                        <AlertCircle className="size-4" />
                        <AlertTitle>异步执行提示</AlertTitle>
                        <AlertDescription>
                            {presentation.warning}
                        </AlertDescription>
                    </Alert>
                ) : null}
            </div>
        );
    }

    if (presentation.kind === "raw") {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                原始结果仅支持显式单语句执行
            </div>
        );
    }

    if (presentation.result.columns.length === 0) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                {presentation.emptyLabel}
            </div>
        );
    }

    return (
        <RelationalDataTable
            result={presentation.result}
            rowHeight={32}
            className="h-full"
            emptyMessage="查询没有返回数据"
        />
    );
};

export const SqlEditorResultPanel: FC<SqlEditorResultPanelProps> = ({
    result,
    outcome,
    error,
    isExecuting,
    page,
    pageSize,
    scriptBatch,
    onPreviousPage,
    onNextPage,
    onSelectScriptStatement,
    rawArtifactOwner,
    isSavingRawArtifact = false,
    onSaveRawArtifact,
}) => {
    if (scriptBatch) {
        const selectedStatement =
            scriptBatch.statements.find(
                (item) => item.id === scriptBatch.selectedStatementId,
            ) ??
            scriptBatch.statements.find(
                (item) => item.id === scriptBatch.activeStatementId,
            ) ??
            scriptBatch.statements[0] ??
            null;

        return (
            <div className="flex h-full min-h-0">
                <div className="flex w-72 shrink-0 flex-col border-r bg-muted/20">
                    <div className="border-b px-3 py-2">
                        <div className="truncate text-xs font-medium">
                            {buildSqlScriptResultHeader(scriptBatch)}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                            {scriptBatch.summaryLabel}
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto py-1">
                        {scriptBatch.statements.map((statement) => {
                            const Icon = getScriptStatusIcon(statement);
                            const selected =
                                statement.id === selectedStatement?.id;
                            const elapsed = formatElapsedMs(statement.elapsedMs);

                            return (
                                <button
                                    key={statement.id}
                                    type="button"
                                    className={cn(
                                        "flex w-full min-w-0 items-start gap-2 px-3 py-2 text-left text-xs hover:bg-muted",
                                        selected && "bg-background",
                                    )}
                                    onClick={() =>
                                        onSelectScriptStatement?.(statement.id)
                                    }
                                >
                                    <Icon
                                        className={cn(
                                            "mt-0.5 size-3.5 shrink-0",
                                            statement.status === "running" &&
                                                "animate-spin text-primary",
                                            statement.status === "succeeded" &&
                                                "text-emerald-500",
                                            (statement.status === "failed" ||
                                                statement.status ===
                                                    "cancelFailed") &&
                                                "text-destructive",
                                            statement.status === "timedOut" &&
                                                "text-amber-500",
                                        )}
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-foreground">
                                            {statement.index}. {previewSql(statement.sql)}
                                        </span>
                                        <span className="mt-0.5 block truncate text-muted-foreground">
                                            {getScriptStatusLabel(statement)}
                                            {elapsed ? ` · ${elapsed}` : ""}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                    {selectedStatement ? (
                        <>
                            <div className="shrink-0 border-b px-3 py-2">
                                <div className="text-xs font-medium">
                                    第 {selectedStatement.index} 条 SQL
                                </div>
                                <div className="mt-0.5 max-h-16 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                                    {selectedStatement.sql}
                                </div>
                            </div>
                            <div className="min-h-0 flex-1">
                                <ScriptStatementDetail
                                    statement={selectedStatement}
                                />
                            </div>
                        </>
                    ) : (
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                            没有可显示的脚本结果
                        </div>
                    )}
                </div>
            </div>
        );
    }

    if (isExecuting) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-4" />
                执行查询中...
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-3">
                <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertTitle>执行失败</AlertTitle>
                    <AlertDescription>{formatIpcError(error)}</AlertDescription>
                </Alert>
            </div>
        );
    }

    const presentation = buildSqlExecutionOutcomePresentation(
        outcome ?? null,
        result,
    );

    if (!presentation) {
        return (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                运行 SQL 后查看结果
            </div>
        );
    }

    if (presentation.kind === "command") {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500" />
                    <span className="text-foreground">
                        {presentation.headline}
                    </span>
                </div>
                {presentation.metricLabel ? (
                    <div>{presentation.metricLabel}</div>
                ) : null}
                {presentation.warning ? (
                    <Alert className="max-w-2xl">
                        <AlertCircle className="size-4" />
                        <AlertTitle>异步执行提示</AlertTitle>
                        <AlertDescription>
                            {presentation.warning}
                        </AlertDescription>
                    </Alert>
                ) : null}
            </div>
        );
    }

    if (presentation.kind === "raw") {
        const owner = rawArtifactOwner
            ? {
                  ...rawArtifactOwner,
                  artifactId: presentation.outcome.artifactId,
                  format: presentation.outcome.format,
              }
            : null;
        return (
            <RawSqlResultView
                outcome={presentation.outcome}
                isSaving={isSavingRawArtifact}
                canSave={owner != null && onSaveRawArtifact != null}
                onSave={() => {
                    if (owner) onSaveRawArtifact?.(owner);
                }}
            />
        );
    }

    const rowResult = presentation.result;
    if (rowResult.columns.length === 0) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-emerald-500" />
                {presentation.emptyLabel}
            </div>
        );
    }

    const paging = buildSqlEditorPagingState({
        rowCount: rowResult.rows.length,
        columnCount: rowResult.columns.length,
        page,
        pageSize,
        hasNextPage: rowResult.hasNextPage,
    });

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
                <RelationalDataTable
                    result={rowResult}
                    rowHeight={32}
                    rowNumberOffset={(page - 1) * pageSize}
                    className="h-full"
                    emptyMessage="查询没有返回数据"
                />
            </div>
            {paging.visible ? (
                <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
                    <span>{paging.rangeLabel}</span>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            disabled={isExecuting || !paging.canPrevious}
                            onClick={onPreviousPage}
                            title="上一页"
                        >
                            <ChevronLeft className="size-3.5" />
                        </Button>
                        <span className="min-w-10 text-center text-foreground">
                            {page}
                        </span>
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            disabled={isExecuting || !paging.canNext}
                            onClick={onNextPage}
                            title="下一页"
                        >
                            <ChevronRight className="size-3.5" />
                        </Button>
                    </div>
                </div>
            ) : null}
        </div>
    );
};
