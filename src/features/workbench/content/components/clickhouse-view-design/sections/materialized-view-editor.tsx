import type { FC } from "react";

import type { ClickHouseViewDesignDraft } from "@/types/clickhouse-view-design";

interface MaterializedViewEditorProps {
    draft: ClickHouseViewDesignDraft;
    disabled: boolean;
    onChange: (draft: ClickHouseViewDesignDraft) => void;
}

export const MaterializedViewEditor: FC<MaterializedViewEditorProps> = ({
    draft,
    disabled,
    onChange,
}) => {
    if (draft.familyDefinition.kind !== "materialized") return null;
    const definition = draft.familyDefinition;
    return (
        <div className="grid gap-3 rounded-md border p-3 text-xs">
            <div className="font-medium">Incremental Materialized View storage</div>
            <div className="text-muted-foreground">
                {definition.value.storage.kind === "to_table"
                    ? `TO ${definition.value.storage.value.target.database ?? ""}.${definition.value.storage.value.target.table ?? ""}`
                    : `${definition.value.storage.value.engine.family} ORDER BY ${definition.value.storage.value.orderBy}`}
            </div>
            <label className="flex items-center gap-2">
                <input
                    type="checkbox"
                    checked={definition.value.populate}
                    disabled={disabled || definition.value.storage.kind === "to_table"}
                    onChange={(event) =>
                        onChange({
                            ...draft,
                            familyDefinition: {
                                ...definition,
                                value: {
                                    ...definition.value,
                                    populate: event.target.checked,
                                },
                            },
                        })
                    }
                />
                POPULATE
            </label>
        </div>
    );
};
