import { ClickHouseIcon } from "@/components/icons/database";
import { CreateClickHouseDatabaseForm } from "@/features/workbench/explorer/components/database-forms/clickhouse-database-forms";
import { ClickHouseConnectionForm } from "@/features/workbench/explorer/components/connection-forms/ClickHouseConnectionForm";
import {
    createDefaultSshTunnelConfig,
    isValidPort,
    validateAdvancedNetworkConfig,
} from "@/features/workbench/explorer/components/connection-forms/connection-form-utils";
import { clickHouseCreateDatabaseOperation } from "@/features/workbench/explorer/driver-configs/create-database-operations";
import {
    clickHouseDatabaseDropOperation,
    clickHouseTableDropOperation,
} from "@/features/workbench/explorer/driver-configs/schema-drop-operations";
import type {
    DatabaseNameFormValue,
    ExplorerDriverConfig,
} from "@/features/workbench/explorer/driver-configs/types";
import type { ClickHouseCreateDatabaseTarget } from "@/types/ipc";

const HTTPS_SSH_SNI_ERROR =
    "HTTPS over SSH is unavailable until the tunnel preserves the original ClickHouse hostname for TLS SNI verification";

export const clickhouseDriverConfig: ExplorerDriverConfig<"clickhouse"> = {
    driver: "clickhouse",
    displayName: "ClickHouse",
    pickerDescription: "连接到 ClickHouse 或 ClickHouse Cloud 分析数据库",
    pickerIcon: ClickHouseIcon,
    category: "analytics",
    treeVisual: {
        icon: ClickHouseIcon,
        iconClassName: "text-amber-500",
    },
    connectionModel: "network",
    dropDatabase: clickHouseDatabaseDropOperation,
    dropTable: clickHouseTableDropOperation,
    createDatabase: {
        operation: clickHouseCreateDatabaseOperation,
        createDefaultValue: (): DatabaseNameFormValue => ({ name: "" }),
        validate: (value) =>
            value.name.trim() ? null : "请填写数据库名称",
        buildInput: (value): ClickHouseCreateDatabaseTarget => ({
            name: value.name,
        }),
        renderForm: ({ value, onChange, disabled }) => (
            <CreateClickHouseDatabaseForm
                value={value}
                onChange={onChange}
                disabled={disabled}
            />
        ),
    },
    createDefaultConfig: () => ({
        host: "",
        port: 8123,
        username: "default",
        password: "",
        savePassword: false,
        defaultDatabase: "default",
        protocol: "http",
        connectTimeoutSeconds: 5,
        sshTunnel: createDefaultSshTunnelConfig(),
    }),
    validate: (config) => {
        if (!config.host.trim()) {
            return "请填写主机地址";
        }
        if (!isValidPort(config.port)) {
            return "端口必须是 1–65535 之间的整数";
        }
        if (!config.username?.trim()) {
            return "请填写用户名";
        }
        if (config.protocol !== "http" && config.protocol !== "https") {
            return "连接协议必须是 HTTP 或 HTTPS";
        }
        if (config.protocol === "https" && config.sshTunnel?.enabled) {
            return HTTPS_SSH_SNI_ERROR;
        }
        return validateAdvancedNetworkConfig(config);
    },
    renderForm: ({ value, onChange, disabled }) => (
        <ClickHouseConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
