import type { FC } from "react";

import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";

interface RefreshableViewEditorProps {
    draft: ClickHouseViewDesignDraft;
    disabled: boolean;
    onChange: (draft: ClickHouseViewDesignDraft) => void;
}

export const RefreshableViewEditor: FC<RefreshableViewEditorProps> = ({
    draft,
    disabled,
    onChange,
}) => {
    if (draft.familyDefinition.kind !== "refreshable_materialized") return null;
    const definition = draft.familyDefinition;
    const interval = definition.value.refresh.interval;
    return (
        <div className="grid gap-3 rounded-md border p-3 text-xs md:grid-cols-3">
            <label className="grid gap-1">
                <span className="text-muted-foreground">Refresh mode</span>
                <select
                    className="h-8 rounded-md border bg-background px-2"
                    value={definition.value.refresh.mode}
                    disabled={disabled}
                    onChange={(event) =>
                        onChange({
                            ...draft,
                            familyDefinition: {
                                ...definition,
                                value: {
                                    ...definition.value,
                                    refresh: {
                                        ...definition.value.refresh,
                                        mode: event.target.value as "every" | "after" | "dependsOnly",
                                    },
                                },
                            },
                        })
                    }
                >
                    <option value="every">EVERY</option>
                    <option value="after">AFTER</option>
                    <option value="dependsOnly">DEPENDS ON only</option>
                </select>
            </label>
            <label className="grid gap-1">
                <span className="text-muted-foreground">Interval</span>
                <input
                    type="number"
                    min={1}
                    className="h-8 rounded-md border bg-background px-2"
                    value={interval?.value ?? 1}
                    disabled={disabled || definition.value.refresh.mode === "dependsOnly"}
                    onChange={(event) =>
                        onChange({
                            ...draft,
                            familyDefinition: {
                                ...definition,
                                value: {
                                    ...definition.value,
                                    refresh: {
                                        ...definition.value.refresh,
                                        interval: {
                                            value: Number(event.target.value),
                                            unit: interval?.unit ?? "hour",
                                        },
                                    },
                                },
                            },
                        })
                    }
                />
            </label>
            <div className="flex items-end gap-4 pb-2">
                {(["append", "empty"] as const).map((field) => (
                    <label key={field} className="flex items-center gap-2 uppercase">
                        <input
                            type="checkbox"
                            checked={definition.value[field]}
                            disabled={disabled}
                            onChange={(event) =>
                                onChange({
                                    ...draft,
                                    familyDefinition: {
                                        ...definition,
                                        value: {
                                            ...definition.value,
                                            [field]: event.target.checked,
                                        },
                                    },
                                })
                            }
                        />
                        {field}
                    </label>
                ))}
            </div>
        </div>
    );
};
