import type { FC } from "react";

import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";

interface LiveViewEditorProps {
    draft: ClickHouseViewDesignDraft;
}

export const LiveViewEditor: FC<LiveViewEditorProps> = ({ draft }) => {
    if (draft.familyDefinition.kind !== "live") return null;
    return (
        <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
            <div className="font-medium text-destructive">Deprecated Live View</div>
            <p className="text-muted-foreground">
                已识别对象仍可按服务器能力 Describe/Rename/Drop；服务器明确移除时禁止创建。
            </p>
            {draft.familyDefinition.value.canonicalLegacyOptions.map((clause) => (
                <code key={clause} className="rounded bg-muted px-2 py-1">
                    {clause}
                </code>
            ))}
        </div>
    );
};
