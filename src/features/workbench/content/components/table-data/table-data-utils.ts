import type {
    ColumnMeta,
    TableCellChange,
    TableChangeSetRequest,
    TableBrowseQuery,
    TableRowKey,
    TableRowLocator,
} from "@/types/ipc";
import type { TableDataChangeSet } from "@/store";

// ─── TableResourceCapabilities ───────────────────────────────────────────────

export interface TableResourceCapabilities {
    canUpdateCells: boolean;
    canDeleteRows: boolean;
    canInsertRows: boolean;
    canUseTransaction: boolean;
}

export const EMPTY_TABLE_BROWSE_QUERY: TableBrowseQuery = {
    filters: [],
    sort: [],
};

// ─── Value coercion & clipboard ──────────────────────────────────────────────

export function coerceEditedValue(
    rawValue: unknown,
    originalValue: unknown,
    column?: ColumnMeta,
): unknown {
    if (rawValue === null || typeof rawValue === "boolean") {
        return rawValue;
    }
    const rawText = String(rawValue);

    if (column?.dataCategory === "boolean") {
        if (rawText.length === 0 && column.nullable) return null;
        const normalized = rawText.trim().toLowerCase();
        if (["true", "1", "yes", "y"].includes(normalized)) return true;
        if (["false", "0", "no", "n"].includes(normalized)) return false;
        throw new Error("请输入 true/false 或 1/0");
    }

    if (originalValue === null || originalValue === undefined) {
        return rawText.length === 0 ? null : rawText;
    }

    if (typeof originalValue === "number") {
        const nextValue = Number(rawText);
        if (!Number.isFinite(nextValue)) {
            throw new Error("请输入有效数字");
        }
        return nextValue;
    }

    if (typeof originalValue === "boolean") {
        const normalized = rawText.trim().toLowerCase();
        if (["true", "1", "yes", "y"].includes(normalized)) return true;
        if (["false", "0", "no", "n"].includes(normalized)) return false;
        throw new Error("请输入 true/false 或 1/0");
    }

    if (typeof originalValue === "string") {
        return rawText;
    }

    throw new Error("暂不支持编辑对象或数组类型的值");
}

export function valueToClipboardText(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

export function rowsToClipboardText(rows: unknown[][]): string {
    return rows
        .map((row) => row.map((value) => valueToClipboardText(value)).join("\t"))
        .join("\n");
}

// ─── Column helpers ──────────────────────────────────────────────────────────

export function isTextLikeColumn(column: ColumnMeta | null | undefined): boolean {
    if (!column) return false;
    if (column.dataCategory === "string") return true;
    const normalized = column.typeName?.toLowerCase() ?? "";
    return ["char", "text", "clob", "string"].some((token) =>
        normalized.includes(token),
    );
}

// ─── Row key helpers ─────────────────────────────────────────────────────────

export function rowLocatorToId(locator: TableRowLocator): string {
    return JSON.stringify([
        locator.kind,
        locator.parts.map((part) => [part.column, part.value]),
    ]);
}

export function fallbackRowUpdateId(page: number, rowIndex: number): string {
    return `row-index:${page}:${rowIndex}`;
}

export function rowKeyHasCompleteValues(primaryKey: TableRowKey): boolean {
    return (
        primaryKey.length > 0 &&
        primaryKey.every((part) => part.value !== null && part.value !== undefined)
    );
}

// ─── Draft & change set helpers ──────────────────────────────────────────────

export function createDraftId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function changeSetIsEmpty(changeSet: TableDataChangeSet): boolean {
    return (
        Object.keys(changeSet.inserts).length === 0 &&
        Object.keys(changeSet.updates).length === 0 &&
        Object.keys(changeSet.deletes).length === 0
    );
}

export function changeSetToRequest(
    changeSet: TableDataChangeSet,
): TableChangeSetRequest {
    const deletedRowIds = new Set(Object.keys(changeSet.deletes));
    const inserts = Object.values(changeSet.inserts).map((insert) => ({
        values: Object.entries(insert.values).map<TableCellChange>(
            ([column, value]) => ({ column, value }),
        ),
    }));
    const updates = Object.entries(changeSet.updates)
        .filter(([rowId]) => !deletedRowIds.has(rowId))
        .map(([, update]) => ({
            locator: update.locator,
            changes: Object.entries(update.changes).map<TableCellChange>(
                ([column, value]) => ({ column, value }),
            ),
        }))
        .filter((update) => update.changes.length > 0);

    return {
        inserts,
        updates,
        deletes: Object.values(changeSet.deletes),
    };
}

export function withoutEmptyDraftInserts(changeSet: TableDataChangeSet): TableDataChangeSet {
    return {
        inserts: Object.fromEntries(
            Object.entries(changeSet.inserts).filter(
                ([, insert]) => Object.keys(insert.values).length > 0,
            ),
        ),
        updates: changeSet.updates,
        deletes: changeSet.deletes,
    };
}
