import { cn } from "@/lib/utils";

// ─── DataTableEmpty Props ──────────────────────────────────────────────────────

interface DataTableEmptyProps {
  message?: string;
  className?: string;
}

// ─── DataTableEmpty ────────────────────────────────────────────────────────────

export function DataTableEmpty({
  message = "暂无数据",
  className,
}: DataTableEmptyProps) {
  return (
    <div
      data-slot="data-table-empty"
      className={cn(
        "flex flex-1 items-center justify-center text-sm text-muted-foreground",
        className,
      )}
    >
      {message}
    </div>
  );
}
