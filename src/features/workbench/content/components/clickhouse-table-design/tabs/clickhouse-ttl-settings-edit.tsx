import type { FC } from "react";

import { cloneClickHouseTableEditDraft } from "../clickhouse-table-edit-draft";
import type { ClickHouseEditSectionProps } from "./clickhouse-columns-edit";
import { ClickHouseTtlSettingsCreate } from "./clickhouse-ttl-settings-create";

export const ClickHouseTtlSettingsEdit: FC<ClickHouseEditSectionProps> = ({
    draft,
    issues,
    disabled,
    onChange,
}) => (
    <ClickHouseTtlSettingsCreate
        draft={draft.table}
        issues={issues.map((issue) => ({
            ...issue,
            code: "edit_validation",
        }))}
        disabled={disabled}
        onChange={(table) =>
            onChange(cloneClickHouseTableEditDraft({ ...draft, table }))
        }
    />
);
