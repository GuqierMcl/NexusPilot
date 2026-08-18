import { useMemo } from "react";
import type React from "react";
import { Asterisk, Ban, Database, KeyRound, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ColumnMeta, QueryResult } from "@/types/ipc";
import {
  DataTable,
  type DataTableColumn,
  type DataTableHeaderMetaRenderer,
  type DataTableProps,
} from "@/components/ui/data-table";
import { StructuredValuePreview } from "./structured-value-preview";

type RelationalQueryResultLike = Pick<QueryResult, "columns" | "rows">;

const EMPTY_RELATIONAL_COLUMNS: ColumnMeta[] = [];
const EMPTY_RELATIONAL_ROWS: unknown[][] = [];

export interface RelationalDataTableProps
  extends Omit<
    DataTableProps,
    "columns" | "rows" | "preset" | "renderColumnHeaderMeta"
  > {
  columns?: ColumnMeta[];
  rows?: unknown[][];
  result?: RelationalQueryResultLike | null;
  columnWidth?: number;
}

interface HeaderBadgeProps {
  tooltip: string;
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof Badge>["variant"];
  className?: string;
}

function HeaderBadge({
  tooltip,
  children,
  variant = "outline",
  className,
}: HeaderBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant={variant} className={cn("h-4 px-1 text-[10px]", className)}>
            {children}
          </Badge>
        }
      />
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function toDataTableColumns(
  columns: ColumnMeta[],
  columnWidth: number,
): DataTableColumn[] {
  return columns.map((column) => ({
    id: column.name,
    header: column.name,
    typeName: column.typeName,
    nullable: column.nullable,
    isPrimaryKey: column.isPrimaryKey,
    isUnique: column.isUnique,
    isWritable: column.isWritable,
    dataCategory: column.dataCategory,
    maxLength: column.maxLength,
    numericPrecision: column.numericPrecision,
    numericScale: column.numericScale,
    enumValues: column.enumValues,
    width: columnWidth,
    cell:
      column.dataCategory === "structured"
        ? (value) => <StructuredValuePreview value={value} />
        : undefined,
  }));
}

const renderRelationalHeaderMeta: DataTableHeaderMetaRenderer = (column) => (
  <div className="flex min-w-0 items-center gap-1 overflow-hidden">
    {column.typeName && (
      <HeaderBadge
        variant="ghost"
        tooltip={`TYPE 数据类型：${column.typeName}`}
        className="max-w-full font-normal"
      >
        <Database data-icon="inline-start" />
        <span className="truncate">{column.typeName}</span>
      </HeaderBadge>
    )}
    {column.isPrimaryKey && (
      <HeaderBadge variant="secondary" tooltip="PRIMARY KEY 主键">
        <KeyRound data-icon="inline-start" />
        PK
      </HeaderBadge>
    )}
    {column.nullable === false && (
      <HeaderBadge tooltip="NOT NULL 非空">
        <Asterisk data-icon="inline-start" />
        NN
      </HeaderBadge>
    )}
    {column.isUnique && !column.isPrimaryKey && (
      <HeaderBadge tooltip="UNIQUE 唯一约束/唯一索引">
        <ShieldCheck data-icon="inline-start" />
        UQ
      </HeaderBadge>
    )}
    {column.isWritable === false && (
      <HeaderBadge variant="ghost" tooltip="READ ONLY 只读列">
        <Ban data-icon="inline-start" />
        RO
      </HeaderBadge>
    )}
  </div>
);

export function RelationalDataTable({
  columns,
  rows,
  result,
  columnWidth = 180,
  ...props
}: RelationalDataTableProps) {
  const dataTableColumns = useMemo(
    () =>
      toDataTableColumns(
        result?.columns ?? columns ?? EMPTY_RELATIONAL_COLUMNS,
        columnWidth,
      ),
    [result?.columns, columns, columnWidth],
  );
  const dataTableRows = result?.rows ?? rows ?? EMPTY_RELATIONAL_ROWS;

  return (
    <DataTable
      {...props}
      preset="database"
      columns={dataTableColumns}
      rows={dataTableRows}
      renderColumnHeaderMeta={renderRelationalHeaderMeta}
    />
  );
}
