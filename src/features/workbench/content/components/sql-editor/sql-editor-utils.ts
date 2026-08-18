import type { SqlExecutionContext } from "@/types/saved-queries";

import {
    countExecutableSqlStatements,
    findExecutableStatementAtOffset,
    parseSqlStatementRanges,
} from "./sql-statement-ranges";

export interface SqlEditorSnapshot {
    title: string;
    sqlText: string;
    context: SqlExecutionContext;
}

export interface SqlEditorSaveSuccessPatch {
    patch: {
        sqlText?: string;
        context?: SqlExecutionContext;
        isSaveDialogOpen: false;
        savedSnapshot: SqlEditorSnapshot;
    };
    shouldClearDirty: boolean;
}

export function normalizeSqlContext(
    context?: SqlExecutionContext | null,
): SqlExecutionContext {
    return {
        database: context?.database?.trim() || null,
        schema: context?.schema?.trim() || null,
    };
}

export function sqlContextsEqual(
    left?: SqlExecutionContext | null,
    right?: SqlExecutionContext | null,
): boolean {
    const normalizedLeft = normalizeSqlContext(left);
    const normalizedRight = normalizeSqlContext(right);
    return (
        (normalizedLeft.database ?? "") === (normalizedRight.database ?? "") &&
        (normalizedLeft.schema ?? "") === (normalizedRight.schema ?? "")
    );
}

export function getExecutableSql(fullText: string, selectedText?: string | null): string {
    const selected = selectedText?.trim();
    if (selected) return selected;
    return fullText.trim();
}

export type SqlExecutionTarget =
    | {
          ok: true;
          source: "selection" | "cursor";
          sql: string;
      }
    | {
          ok: false;
          reason: "empty" | "multiple" | "no_statement";
      };

export type SqlRunTargetSource = "selection" | "all";

export type SqlPrimaryRunTarget =
    | {
          ok: true;
          kind: "single";
          source: SqlRunTargetSource;
          sql: string;
          statementCount: 1;
      }
    | {
          ok: true;
          kind: "script";
          source: SqlRunTargetSource;
          sqlText: string;
          statementCount: number;
      }
    | {
          ok: false;
          reason: "empty";
      };

export type SqlCurrentStatementTarget =
    | {
          ok: true;
          source: "current";
          sql: string;
          statementIndex: number;
      }
    | {
          ok: false;
          reason: "empty" | "no_statement";
      };

export function hasMultipleExecutableStatements(sql: string): boolean {
    return countExecutableSqlStatements(sql) > 1;
}

function findExecutableStatementIndexAtOffset(
    fullText: string,
    cursorOffset: number,
): number {
    const executableRanges = parseSqlStatementRanges(fullText).filter(
        (range) => range.executable,
    );
    const index = executableRanges.findIndex(
        (range) =>
            cursorOffset >= range.startOffset && cursorOffset <= range.endOffset,
    );
    return index >= 0 ? index + 1 : 1;
}

export function resolveSqlPrimaryRunTarget(params: {
    fullText: string;
    selectedText?: string | null;
}): SqlPrimaryRunTarget {
    const selectedSql = params.selectedText?.trim() ?? "";
    const source: SqlRunTargetSource = selectedSql ? "selection" : "all";
    const sqlText = source === "selection" ? selectedSql : params.fullText.trim();
    const executableRanges = parseSqlStatementRanges(sqlText).filter(
        (range) => range.executable,
    );

    if (executableRanges.length === 0) {
        return { ok: false, reason: "empty" };
    }

    if (executableRanges.length === 1) {
        return {
            ok: true,
            kind: "single",
            source,
            sql: executableRanges[0].text,
            statementCount: 1,
        };
    }

    return {
        ok: true,
        kind: "script",
        source,
        sqlText,
        statementCount: executableRanges.length,
    };
}

export function resolveSqlCurrentStatementTarget(params: {
    fullText: string;
    cursorOffset: number;
}): SqlCurrentStatementTarget {
    const executableRanges = parseSqlStatementRanges(params.fullText).filter(
        (range) => range.executable,
    );
    if (executableRanges.length === 0) {
        return { ok: false, reason: "empty" };
    }

    const cursorStatement = findExecutableStatementAtOffset(
        params.fullText,
        params.cursorOffset,
    );
    if (!cursorStatement) {
        return { ok: false, reason: "no_statement" };
    }

    const statementIndex =
        executableRanges.findIndex(
            (range) =>
                range.startOffset === cursorStatement.startOffset &&
                range.endOffset === cursorStatement.endOffset,
        ) + 1;

    return {
        ok: true,
        source: "current",
        sql: cursorStatement.text,
        statementIndex: statementIndex > 0 ? statementIndex : 1,
    };
}

export function resolveSqlExecutionTarget(params: {
    fullText: string;
    selectedText?: string | null;
    cursorOffset: number;
}): SqlExecutionTarget {
    const selectedSql = params.selectedText?.trim() ?? "";
    if (selectedSql) {
        const selectedRanges = parseSqlStatementRanges(selectedSql).filter(
            (range) => range.executable,
        );
        if (selectedRanges.length === 0) return { ok: false, reason: "empty" };
        if (selectedRanges.length > 1) return { ok: false, reason: "multiple" };
        return {
            ok: true,
            source: "selection",
            sql: selectedRanges[0].text,
        };
    }

    if (countExecutableSqlStatements(params.fullText) === 0) {
        return { ok: false, reason: "empty" };
    }

    const cursorStatement = findExecutableStatementAtOffset(
        params.fullText,
        params.cursorOffset,
    );
    if (!cursorStatement) {
        return { ok: false, reason: "no_statement" };
    }

    return {
        ok: true,
        source: "cursor",
        sql: cursorStatement.text,
    };
}

export type SqlExecutionTargetHintTone =
    | "ready"
    | "running"
    | "blocked"
    | "idle";

export interface SqlExecutionTargetHint {
    tone: SqlExecutionTargetHintTone;
    label: string;
    title: string;
    runTitle: string;
}

export function buildSqlPrimaryRunHint(params: {
    fullText: string;
    selectedText?: string | null;
    isExecuting: boolean;
}): SqlExecutionTargetHint {
    const target = resolveSqlPrimaryRunTarget(params);
    if (!target.ok) {
        return {
            tone: "idle",
            label: "输入 SQL 后运行",
            title: "编辑器内没有可执行 SQL",
            runTitle: "SQL 不能为空",
        };
    }

    const sourceLabel =
        target.source === "selection" ? "已选取 SQL" : "全部 SQL";
    if (target.kind === "single") {
        const prefix = params.isExecuting ? "正在执行" : "将执行";
        return {
            tone: params.isExecuting ? "running" : "ready",
            label: `${prefix}${sourceLabel} · 1 条`,
            title:
                target.source === "selection"
                    ? params.isExecuting
                        ? "当前正在执行选中的单条 SQL"
                        : "点击运行会执行当前选中的单条 SQL"
                    : params.isExecuting
                      ? "当前正在执行编辑器内唯一一条 SQL"
                      : "点击运行会执行编辑器内唯一一条 SQL",
            runTitle:
                target.source === "selection" ? "执行已选取 SQL" : "运行全部 SQL",
        };
    }

    const prefix = params.isExecuting ? "正在按顺序执行" : "将按顺序执行";
    return {
        tone: params.isExecuting ? "running" : "ready",
        label: `${prefix}${sourceLabel} · ${target.statementCount} 条`,
        title:
            target.source === "selection"
                ? params.isExecuting
                    ? `当前正在按顺序执行选中的 ${target.statementCount} 条 SQL`
                    : `点击运行会按顺序执行当前选中的 ${target.statementCount} 条 SQL`
                : params.isExecuting
                  ? `当前正在按顺序执行编辑器内的 ${target.statementCount} 条 SQL`
                  : `点击运行会按顺序执行编辑器内的 ${target.statementCount} 条 SQL`,
        runTitle:
            target.source === "selection"
                ? "按顺序执行已选取 SQL"
                : "运行全部 SQL",
    };
}

export function buildSqlCurrentStatementHint(params: {
    fullText: string;
    cursorOffset: number;
    isExecuting: boolean;
}): SqlExecutionTargetHint {
    const target = resolveSqlCurrentStatementTarget(params);
    if (!target.ok) {
        if (target.reason === "no_statement") {
            return {
                tone: "idle",
                label: "不会执行：光标不在可执行 SQL 内",
                title: "将光标放到一条 SQL 语句内后运行当前语句",
                runTitle: "光标不在可执行 SQL 内",
            };
        }
        return {
            tone: "idle",
            label: "输入 SQL 后运行当前语句",
            title: "编辑器内没有可执行 SQL",
            runTitle: "SQL 不能为空",
        };
    }

    const prefix = params.isExecuting ? "正在执行" : "将执行";
    return {
        tone: params.isExecuting ? "running" : "ready",
        label: `${prefix}当前语句 · 第 ${target.statementIndex} 条`,
        title: params.isExecuting
            ? "当前正在执行光标所在 SQL 语句"
            : "点击运行当前语句会执行光标所在 SQL 语句",
        runTitle: "执行当前语句",
    };
}

export function buildSqlExecutionTargetHint(params: {
    fullText: string;
    selectedText?: string | null;
    cursorOffset: number;
    isExecuting: boolean;
}): SqlExecutionTargetHint {
    const target = resolveSqlExecutionTarget(params);
    if (!target.ok) {
        if (target.reason === "multiple") {
            return {
                tone: "blocked",
                label: "不会执行：已选取多条 SQL",
                title: "运行前请只选中一条 SQL，或取消选择后将光标放到目标语句内",
                runTitle: "已选取多条 SQL，无法直接运行",
            };
        }
        if (target.reason === "no_statement") {
            return {
                tone: "idle",
                label: "不会执行：光标不在可执行 SQL 内",
                title: "将光标放到一条 SQL 语句内，或选中一条 SQL 后运行",
                runTitle: "光标不在可执行 SQL 内",
            };
        }
        return {
            tone: "idle",
            label: "输入 SQL 后运行",
            title: "编辑器内没有可执行 SQL",
            runTitle: "SQL 不能为空",
        };
    }

    const prefix = params.isExecuting ? "正在执行" : "将执行";
    if (target.source === "selection") {
        return {
            tone: params.isExecuting ? "running" : "ready",
            label: `${prefix}已选取 SQL · 1 条`,
            title: params.isExecuting
                ? "当前正在执行选中的单条 SQL"
                : "点击运行会执行当前选中的单条 SQL",
            runTitle: "执行已选取 SQL",
        };
    }

    const statementIndex = findExecutableStatementIndexAtOffset(
        params.fullText,
        params.cursorOffset,
    );
    return {
        tone: params.isExecuting ? "running" : "ready",
        label: `${prefix}光标所在语句 · 第 ${statementIndex} 条`,
        title: params.isExecuting
            ? "当前正在执行光标所在 SQL 语句"
            : "点击运行会执行光标所在 SQL 语句",
        runTitle: "执行光标所在语句",
    };
}

export function buildSqlScriptExecutionHint(params: {
    sqlText: string;
    source: SqlRunTargetSource;
    isExecuting: boolean;
    stopRequested: boolean;
}): SqlExecutionTargetHint {
    const statementCount = countExecutableSqlStatements(params.sqlText);
    const sourceLabel =
        params.source === "selection" ? "已选取 SQL" : "全部 SQL";
    if (statementCount === 0) {
        return {
            tone: "idle",
            label:
                params.source === "selection"
                    ? "选取 SQL 后运行"
                    : "输入 SQL 后运行全部",
            title: "编辑器内没有可执行 SQL",
            runTitle: "SQL 不能为空",
        };
    }

    if (params.isExecuting) {
        return {
            tone: "running",
            label: params.stopRequested
                ? "正在停止队列 · 当前 SQL 完成后停止"
                : `正在按顺序执行${sourceLabel} · ${statementCount} 条`,
            title: params.stopRequested
                ? "已请求停止队列，不会取消当前正在执行的 SQL"
                : params.source === "selection"
                  ? `正在按顺序执行选中的 ${statementCount} 条 SQL`
                  : `正在按顺序执行编辑器内的 ${statementCount} 条 SQL`,
            runTitle: "脚本正在执行",
        };
    }

    return {
        tone: "ready",
        label: `将按顺序执行${sourceLabel} · ${statementCount} 条`,
        title:
            params.source === "selection"
                ? `点击运行已选取 SQL 会按顺序执行选中的 ${statementCount} 条 SQL`
                : `点击运行全部会按顺序执行编辑器内的 ${statementCount} 条 SQL`,
        runTitle:
            params.source === "selection"
                ? "按顺序执行已选取 SQL"
                : "按顺序执行全部 SQL",
    };
}

export function sqlEditorIsDirty(params: {
    title: string;
    sqlText: string;
    context: SqlExecutionContext;
    savedSnapshot: SqlEditorSnapshot | null;
}): boolean {
    if (!params.savedSnapshot) {
        return params.sqlText.trim().length > 0;
    }
    return (
        params.title !== params.savedSnapshot.title ||
        params.sqlText !== params.savedSnapshot.sqlText ||
        !sqlContextsEqual(params.context, params.savedSnapshot.context)
    );
}

export function buildSqlEditorSaveSuccessPatch(params: {
    currentSqlText: string;
    currentContext: SqlExecutionContext;
    submittedSqlText: string;
    submittedContext: SqlExecutionContext;
    persistedTitle: string;
    persistedSqlText: string;
    persistedContext: SqlExecutionContext;
}): SqlEditorSaveSuccessPatch {
    const persistedContext = normalizeSqlContext(params.persistedContext);
    const savedSnapshot: SqlEditorSnapshot = {
        title: params.persistedTitle,
        sqlText: params.persistedSqlText,
        context: persistedContext,
    };
    const editorStillMatchesSubmittedSave =
        params.currentSqlText === params.submittedSqlText &&
        sqlContextsEqual(params.currentContext, params.submittedContext);

    if (!editorStillMatchesSubmittedSave) {
        return {
            patch: {
                isSaveDialogOpen: false,
                savedSnapshot,
            },
            shouldClearDirty: false,
        };
    }

    return {
        patch: {
            sqlText: params.persistedSqlText,
            context: persistedContext,
            isSaveDialogOpen: false,
            savedSnapshot,
        },
        shouldClearDirty: true,
    };
}

export interface SqlEditorResultPanelLayout {
    [panelId: string]: number;
    editorPanel: number;
    resultPanel: number;
}

export function getSqlEditorResultPanelSize(size: number): number {
    if (!Number.isFinite(size)) return 35;
    return Math.min(60, Math.max(25, Math.round(size)));
}

export function buildSqlEditorResultPanelLayout(params: {
    collapsed: boolean;
    resultPanelSize: number;
}): SqlEditorResultPanelLayout {
    if (params.collapsed) {
        return {
            editorPanel: 100,
            resultPanel: 0,
        };
    }

    const resultPanel = getSqlEditorResultPanelSize(params.resultPanelSize);
    return {
        editorPanel: 100 - resultPanel,
        resultPanel,
    };
}

export interface SqlEditorResultPanelToggleActionState {
    icon: "resultPanelOpen" | "resultPanelClose";
    label: string;
    title: string;
    pressed: boolean;
}

export function getSqlEditorResultPanelToggleActionState(params: {
    collapsed: boolean;
}): SqlEditorResultPanelToggleActionState {
    if (params.collapsed) {
        return {
            icon: "resultPanelOpen",
            label: "展开结果",
            title: "展开结果栏",
            pressed: false,
        };
    }

    return {
        icon: "resultPanelClose",
        label: "折叠结果",
        title: "折叠结果栏",
        pressed: true,
    };
}

export interface SqlEditorPagingState {
    visible: boolean;
    canPrevious: boolean;
    canNext: boolean;
    rangeLabel: string;
}

export function buildSqlEditorPagingState(params: {
    rowCount: number;
    columnCount: number;
    page: number;
    pageSize: number;
    hasNextPage: boolean;
}): SqlEditorPagingState {
    const hasRowsResult = params.columnCount > 0;
    if (!hasRowsResult) {
        return {
            visible: false,
            canPrevious: false,
            canNext: false,
            rangeLabel: "0 行",
        };
    }

    if (params.rowCount === 0) {
        return {
            visible: true,
            canPrevious: params.page > 1,
            canNext: false,
            rangeLabel: "0 行",
        };
    }

    const firstRow = (params.page - 1) * params.pageSize + 1;
    const lastRow = firstRow + params.rowCount - 1;
    const suffix = params.hasNextPage ? " · 还有更多行" : "";

    return {
        visible: true,
        canPrevious: params.page > 1,
        canNext: params.hasNextPage,
        rangeLabel: `第 ${firstRow}–${lastRow} 行${suffix}`,
    };
}
