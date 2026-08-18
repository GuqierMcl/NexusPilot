import type { FC } from "react";

import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";

interface WindowViewEditorProps {
    draft: ClickHouseViewDesignDraft;
    disabled: boolean;
    onChange: (draft: ClickHouseViewDesignDraft) => void;
}

export const WindowViewEditor: FC<WindowViewEditorProps> = ({
    draft,
    disabled,
    onChange,
}) => {
    if (draft.familyDefinition.kind !== "window") return null;
    const definition = draft.familyDefinition;
    return (
        <div className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-300">
                Experimental — request-local allow_experimental_window_view only
            </div>
            <label className="grid gap-1">
                <span className="text-muted-foreground">Time window function</span>
                <input
                    className="h-8 rounded-md border bg-background px-2"
                    value={definition.value.timeWindowFunction}
                    disabled={disabled}
                    onChange={(event) =>
                        onChange({
                            ...draft,
                            familyDefinition: {
                                ...definition,
                                value: {
                                    ...definition.value,
                                    timeWindowFunction: event.target.value,
                                },
                            },
                        })
                    }
                />
            </label>
        </div>
    );
};
