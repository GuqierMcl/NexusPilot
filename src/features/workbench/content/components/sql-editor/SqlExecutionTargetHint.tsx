import type { FC } from "react";
import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { SqlExecutionTargetHint as SqlExecutionTargetHintModel } from "./sql-editor-utils";

interface SqlExecutionTargetHintProps {
    hint: SqlExecutionTargetHintModel;
}

export const SqlExecutionTargetHint: FC<SqlExecutionTargetHintProps> = ({
    hint,
}) => {
    const Icon =
        hint.tone === "running"
            ? Loader2
            : hint.tone === "blocked"
              ? CircleAlert
              : CircleCheck;

    return (
        <div
            className={cn(
                "flex min-w-0 items-center gap-1.5 rounded border px-2 py-1 text-xs",
                hint.tone === "blocked"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : "border-border bg-muted/40 text-muted-foreground",
            )}
            title={hint.title}
        >
            <Icon
                className={cn(
                    "size-3.5 shrink-0",
                    hint.tone === "running" && "animate-spin",
                )}
            />
            <span className="truncate">{hint.label}</span>
        </div>
    );
};
