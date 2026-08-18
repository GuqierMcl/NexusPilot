import { SqliteIcon } from "@/components/icons/database";

import { SqliteConnectionForm } from "@/features/workbench/explorer/components/connection-forms/SqliteConnectionForm";
import type { ExplorerDriverConfig } from "@/features/workbench/explorer/driver-configs/types";

export const sqliteDriverConfig: ExplorerDriverConfig<"sqlite"> = {
    driver: "sqlite",
    displayName: "SQLite",
    pickerDescription: "连接到本地 SQLite 数据库文件",
    pickerIcon: SqliteIcon,
    category: "rdbms",
    treeVisual: {
        icon: SqliteIcon,
        iconClassName: "text-sky-500",
    },
    connectionModel: "local-file",
    savedQueryContextLevels: ["database"],
    createDefaultConfig: () => ({
        dbFilePath: "",
        isReadOnly: true,
    }),
    validate: (config) => {
        if (!config.dbFilePath.trim()) {
            return "请填写 SQLite 数据库文件路径";
        }
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <SqliteConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
