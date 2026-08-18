import type { FC } from "react";

import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";

interface NormalViewEditorProps {
    draft: ClickHouseViewDesignDraft;
    disabled: boolean;
    onChange: (draft: ClickHouseViewDesignDraft) => void;
}

export const NormalViewEditor: FC<NormalViewEditorProps> = ({
    draft,
    disabled,
    onChange,
}) => (
    <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">Comment</span>
            <input
                className="h-8 rounded-md border bg-background px-2"
                value={draft.comment ?? ""}
                disabled={disabled}
                onChange={(event) =>
                    onChange({ ...draft, comment: event.target.value || null })
                }
            />
        </label>
        <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">SQL Security</span>
            <select
                className="h-8 rounded-md border bg-background px-2"
                value={draft.security.sqlSecurity ?? ""}
                disabled={disabled}
                onChange={(event) =>
                    onChange({
                        ...draft,
                        security: {
                            ...draft.security,
                            sqlSecurity:
                                event.target.value === ""
                                    ? null
                                    : (event.target.value as "definer" | "invoker" | "none"),
                        },
                    })
                }
            >
                <option value="">Default</option>
                <option value="definer">Definer</option>
                <option value="invoker">Invoker</option>
                <option value="none">None</option>
            </select>
        </label>
    </div>
);
