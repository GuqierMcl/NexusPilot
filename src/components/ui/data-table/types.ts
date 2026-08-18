import type { Table } from "@tanstack/react-table";
import type React from "react";

// ─── Column Definition ─────────────────────────────────────────────────────────

export type DataTableCellDataCategory =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "json"
  | "structured"
  | "enum"
  | "binary"
  | "uuid"
  | "unknown";

export interface DataTableColumn {
  /** Unique column identifier */
  id: string;
  /** Display header text */
  header: string;
  /** Optional domain-specific type label used by adapters and cell editors. */
  typeName?: string;
  /** Optional domain metadata used by adapters and cell editors. */
  nullable?: boolean;
  /** Optional domain metadata used by adapters. */
  isPrimaryKey?: boolean;
  /** Optional domain metadata used by adapters. */
  isUnique?: boolean;
  /** Optional domain metadata used by adapters and cell editors. */
  isWritable?: boolean;
  /** Normalized value category used by the cell editor. */
  dataCategory?: DataTableCellDataCategory;
  /** Maximum text length if the data source exposes it. */
  maxLength?: number | null;
  /** Numeric precision if the data source exposes it. */
  numericPrecision?: number | null;
  /** Numeric scale if the data source exposes it. */
  numericScale?: number | null;
  /** Enum values for enum-like columns. */
  enumValues?: string[] | null;
  /** Column width in pixels (default: 160) */
  width?: number;
  /** Minimum column width when resizing (default: 60) */
  minWidth?: number;
  /** Maximum column width when resizing */
  maxWidth?: number;
  /** Custom cell renderer. Receives the raw cell value and row index. */
  cell?: (value: unknown, rowIndex: number) => React.ReactNode;
  /** Whether this column cannot be resized */
  disableResizing?: boolean;

  /**
   * Whether this column is frozen (sticky) during horizontal scroll.
   * Frozen columns use CSS `position: sticky; left: <cumulative-offset>`.
   *
   * @default false — no column is frozen by default.
   *
   * @remarks
   * Can be set declaratively here, or controlled at table level via
   * `DataTableProps.frozenColumnIds`.
   *
   * ── Future extensibility ──
   * Planned support for runtime "freeze this column" via right-click context
   * menu. When implemented, the parent component will manage
   * `frozenColumnIds` as controlled state and pass `onFreezeColumn` /
   * `onUnfreezeColumn` callbacks.
   */
  frozen?: boolean;
}

export type DataTablePreset = "default" | "database" | "compact" | "keyValue";

export type DataTableRowNumberFormatter = (
  rowIndex: number,
  displayIndex: number,
  rowData: unknown[],
  state: {
    isDraftRow: boolean;
  },
) => React.ReactNode;

export type DataTableHeaderMetaRenderer = (
  column: DataTableColumn,
) => React.ReactNode;

// ─── DataTable Props ───────────────────────────────────────────────────────────

export interface DataTableProps {
  /** Visual density/behavior preset for common project-level scenarios. */
  preset?: DataTablePreset;
  /** Column definitions */
  columns: DataTableColumn[];
  /** Row data as 2D array (each inner array matches column order) */
  rows: unknown[][];
  /** Whether the table is currently inside a visible active tab. */
  isActive?: boolean;
  /** Fixed row height in pixels (default: 32) */
  rowHeight?: number;
  /** Number of rows to render outside the visible area (default: 20) */
  overscan?: number;
  /** Number of non-frozen columns to render outside the visible area (default: 2). */
  columnOverscan?: number;
  /** Enable column resizing (default: true) */
  enableColumnResizing?: boolean;
  /** Absolute row number offset, usually `(page - 1) * pageSize`. */
  rowNumberOffset?: number;
  /** Whether to render the built-in row number gutter (default: true). */
  showRowNumbers?: boolean;
  /** Width of the built-in row number gutter in pixels. */
  rowNumberWidth?: number;
  /** Custom row number renderer. */
  rowNumberFormatter?: DataTableRowNumberFormatter;
  /** Optional header metadata renderer supplied by domain adapters. */
  renderColumnHeaderMeta?: DataTableHeaderMetaRenderer;
  /** Target row index to scroll into view when scrollToRowSignal changes. */
  scrollToRowIndex?: number | null;
  /** Monotonic signal used to trigger imperative row scrolling. */
  scrollToRowSignal?: number;
  /** Callback when a row is clicked */
  onRowClick?: (rowIndex: number, rowData: unknown[]) => void;
  /** Controlled selected row indexes. */
  selectedRowIndexes?: number[];
  /** Current row index for focus/active-row highlighting. */
  currentRowIndex?: number | null;
  /** Row indexes rendered as pending deletion. */
  pendingDeleteRowIndexes?: number[];
  /** Row indexes rendered as local draft inserts. */
  draftRowIndexes?: number[];
  /** Cells rendered as locally modified but not saved yet. */
  dirtyCells?: Array<{
    rowIndex: number;
    columnId: string;
  }>;
  /** Callback when a row selection gesture occurs. */
  onRowSelect?: (
    rowIndex: number,
    rowData: unknown[],
    event: React.MouseEvent,
  ) => void;
  /** Callback before a row context menu opens. */
  onRowContextMenu?: (
    target: DataTableContextMenuTarget,
    event: React.MouseEvent,
  ) => void;
  /** Row context menu renderer. */
  renderRowContextMenu?: (
    target: DataTableContextMenuTarget,
  ) => React.ReactNode;
  /** Controlled selected cell. */
  selectedCell?: {
    rowIndex: number;
    columnId: string;
  } | null;
  /** Callback when a data cell is selected. */
  onCellSelect?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
    event: React.MouseEvent,
  ) => void;
  /** Callback when a cell is double-clicked. */
  onCellDoubleClick?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
    event: React.MouseEvent,
  ) => void;
  /** Whether a cell can enter edit mode. */
  isCellEditable?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
  ) => boolean;
  /** Currently edited cell. */
  editingCell?: {
    rowIndex: number;
    columnId: string;
    value: unknown;
  } | null;
  /** Commit the current edit. */
  onCellEditCommit?: (
    rowIndex: number,
    columnId: string,
    value: unknown,
  ) => void;
  /** Cancel the current edit. */
  onCellEditCancel?: () => void;
  /** Additional CSS class for the root element */
  className?: string;
  /** Message shown when there are no rows (default: "暂无数据") */
  emptyMessage?: string;

  /**
   * Column IDs to freeze (sticky) during horizontal scroll.
   * Columns are rendered left-to-right in the order they appear in this array,
   * with automatic `left` offset calculated from preceding frozen columns' widths.
   *
   * @default [] — no frozen columns.
   *
   * @example
   * ```tsx
   * <DataTable columns={columns} rows={rows} frozenColumnIds={["id", "name"]} />
   * ```
   *
   * @remarks
   * Merged with any per-column `frozen: true` declarations.
   *
   * ── Future extensibility ──
   * When "freeze this column" right-click menu is implemented:
   * - This becomes a **controlled** prop (parent manages state)
   * - Parent listens to `onFreezeColumn(columnId)` / `onUnfreezeColumn(columnId)`
   * - Context menu calls parent callbacks → parent updates `frozenColumnIds`
   *   → re-renders DataTable with new frozen set
   */
  frozenColumnIds?: string[];
}

// ─── Internal Types ────────────────────────────────────────────────────────────

/** Internal row data object used by @tanstack/react-table */
export interface DataTableRowData {
  [columnId: string]: unknown;
  /** Original row index in the data source */
  __rowIndex: number;
  /** Original row data array */
  __originalRow: unknown[];
  /** Empty-table placeholder row rendered only by the DataTable UI. */
  __isVirtualEmptyRow?: boolean;
}

export type DataTableContextMenuTarget =
  | {
      kind: "rowNumber";
      rowIndex: number;
      rowData: unknown[];
    }
  | {
      kind: "cell";
      rowIndex: number;
      rowData: unknown[];
      columnId: string;
      value: unknown;
    };

/** Resize state: column id → width in pixels */
export type ColumnSizingState = Record<string, number>;

/** Context value provided to child components */
export interface DataTableContextValue {
  /** @tanstack/react-table instance */
  table: Table<DataTableRowData>;
  /** Fixed row height */
  rowHeight: number;
  /** Column definitions */
  columns: DataTableColumn[];
  /** Whether editor-heavy children may mount active Monaco instances. */
  isActive: boolean;
  /** Whether column resizing is enabled */
  enableColumnResizing: boolean;
  /** Fixed width for the built-in row number gutter. */
  rowNumberWidth: number;
  /** Whether the built-in row number gutter is visible. */
  showRowNumbers: boolean;
  /** Absolute row number offset. */
  rowNumberOffset: number;
  /** Active visual/behavior preset. */
  preset: DataTablePreset;
  /** Custom row number renderer. */
  rowNumberFormatter?: DataTableRowNumberFormatter;
  /** Optional header metadata renderer supplied by domain adapters. */
  renderColumnHeaderMeta?: DataTableHeaderMetaRenderer;

  /**
   * Set of frozen column IDs for O(1) lookup during rendering.
   * Derived from `DataTableProps.frozenColumnIds` merged with per-column `frozen: true`.
   */
  frozenColumnIdSet: ReadonlySet<string>;
}
