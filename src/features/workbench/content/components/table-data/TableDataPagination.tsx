import type React from "react";
import { cn } from "@/lib/utils";
import { formatJsonSafeInteger } from "@/lib/json-safe-integer";
import type {
    TablePageStats,
    TableTransactionState,
} from "@/types/ipc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
} from "lucide-react";

import { resolveLastPageTarget } from "./table-pagination-utils";

interface TableDataPaginationProps {
    page: number;
    pageSize: number;
    hasNextPage: boolean;
    canJumpToLastPage: boolean;
    isPageInputEditing: boolean;
    pageInputValue: string;
    currentPageStats: TablePageStats | null;
    isInTransaction: boolean;
    isRollbackRecommended: boolean;
    transactionState: TableTransactionState;
    hasDirtyChanges: boolean;
    dirtySummary: string;
    rowCount: number;
    isPageStatsPending: boolean;
    isDmlPreviewPending: boolean;
    isSavePending: boolean;
    skipNextPageInputBlurRef: React.MutableRefObject<boolean>;
    onFirstPage: () => void;
    onPrevPage: () => void;
    onNextPage: () => void;
    onLastPage: () => void;
    onPageInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    onBeginPageInput: () => void;
    onCommitPageInput: () => void;
    onPageInputValueChange: (value: string) => void;
    onPreviewDml: () => void;
}

export function TableDataPagination({
    page,
    pageSize,
    hasNextPage,
    canJumpToLastPage,
    isPageInputEditing,
    pageInputValue,
    currentPageStats,
    isInTransaction,
    isRollbackRecommended,
    transactionState,
    hasDirtyChanges,
    dirtySummary,
    rowCount,
    isPageStatsPending,
    isDmlPreviewPending,
    isSavePending,
    skipNextPageInputBlurRef,
    onFirstPage,
    onPrevPage,
    onNextPage,
    onLastPage,
    onPageInputKeyDown,
    onBeginPageInput,
    onCommitPageInput,
    onPageInputValueChange,
    onPreviewDml,
}: TableDataPaginationProps) {
    const formattedTotalPages = currentPageStats
        ? formatJsonSafeInteger(currentPageStats.totalPages)
        : null;
    const lastPageIsAddressable = currentPageStats
        ? resolveLastPageTarget(currentPageStats.totalPages) != null
        : true;

    return (
        <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
                {rowCount > 0 && (
                    <span>
                        第 {(page - 1) * pageSize + 1}–
                        {(page - 1) * pageSize + rowCount} 行
                    </span>
                )}
                {rowCount === 0 && <span>0 行</span>}
                {hasNextPage && (
                    <span className="text-muted-foreground/60">
                        · 还有更多行
                    </span>
                )}
                {isInTransaction && (
                    <span
                        className={cn(
                            isRollbackRecommended
                                ? "text-amber-600"
                                : "text-sky-600",
                        )}
                    >
                        · 事务中
                        {transactionState.database
                            ? `：${transactionState.database}`
                            : ""}
                        {isRollbackRecommended ? "（建议回滚）" : ""}
                    </span>
                )}
                {hasDirtyChanges && (
                    <span className="text-amber-600">
                        · 未保存：{dirtySummary}
                    </span>
                )}
                {hasDirtyChanges && (
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-5 px-2 text-[11px]"
                        disabled={isDmlPreviewPending || isSavePending}
                        onClick={onPreviewDml}
                        title="预览即将执行的 DML SQL"
                    >
                        {isDmlPreviewPending ? "加载..." : "DML"}
                    </Button>
                )}
            </div>

            <div className="flex items-center gap-1">
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={page <= 1 || isPageStatsPending}
                    onClick={onFirstPage}
                    title="第一页"
                >
                    <ChevronsLeft className="size-3.5" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={page <= 1 || isPageStatsPending}
                    onClick={onPrevPage}
                    title="上一页"
                >
                    <ChevronLeft className="size-3.5" />
                </Button>
                {isPageInputEditing ? (
                    <Input
                        className="h-6 w-16 rounded border bg-background px-1 text-center text-xs text-foreground outline-none focus:border-ring"
                        value={pageInputValue}
                        autoFocus
                        type="text"
                        inputMode="numeric"
                        disabled={isPageStatsPending}
                        onChange={(event) => onPageInputValueChange(event.target.value)}
                        onKeyDown={onPageInputKeyDown}
                        onBlur={() => {
                            if (skipNextPageInputBlurRef.current) {
                                skipNextPageInputBlurRef.current = false;
                                return;
                            }
                            onCommitPageInput();
                        }}
                    />
                ) : (
                    <button
                        type="button"
                        className="h-6 min-w-14 rounded px-1 text-center text-xs text-foreground hover:bg-muted"
                        onClick={onBeginPageInput}
                        title={
                            currentPageStats
                                ? `跳转页码，共 ${formattedTotalPages} 页`
                                : "输入页码跳转"
                        }
                    >
                        {currentPageStats
                            ? `${page} / ${formattedTotalPages}`
                            : page}
                    </button>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={!hasNextPage || isPageStatsPending}
                    onClick={onNextPage}
                    title="下一页"
                >
                    <ChevronRight className="size-3.5" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={!canJumpToLastPage || isPageStatsPending}
                    onClick={onLastPage}
                    title={
                        lastPageIsAddressable
                            ? "最后一页"
                            : "总页数超出可直接跳转范围"
                    }
                >
                    <ChevronsRight className="size-3.5" />
                </Button>
            </div>
        </div>
    );
}
