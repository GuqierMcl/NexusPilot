import { RefreshCw, TableProperties } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ClickHouseTableDesignViewModel } from "@/types/clickhouse-table-design";

interface ClickHouseSchemaHeaderProps {
    model: ClickHouseTableDesignViewModel;
    isRefreshing: boolean;
    onRefresh: () => void;
    surfaceMode?: "readonly" | "edit";
}

const EDITABILITY_LABELS = {
    editable: "后端可解析",
    restricted: "部分语义受限",
    readonly: "后端只读",
} as const;

export function ClickHouseSchemaHeader({
    model,
    isRefreshing,
    onRefresh,
    surfaceMode = "readonly",
}: ClickHouseSchemaHeaderProps) {
    return (
        <div className="flex shrink-0 items-center gap-3 border-b bg-background px-3 py-2">
            <TableProperties className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{model.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                    {model.engineLabel}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant="outline">ClickHouse</Badge>
                <Badge variant="secondary">
                    {surfaceMode === "edit" ? "受控编辑" : "只读基线"}
                </Badge>
                <Badge variant="outline">
                    {EDITABILITY_LABELS[model.backendEditability]}
                </Badge>
                <Badge
                    variant="outline"
                    title={`结构 revision: ${model.revisionHash}`}
                >
                    rev {model.revisionHash.slice(0, 8)}
                </Badge>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={isRefreshing}
                    onClick={onRefresh}
                    title="刷新表结构"
                    aria-label="刷新 ClickHouse 表结构"
                >
                    <RefreshCw data-icon="inline-start" />
                </Button>
            </div>
        </div>
    );
}
