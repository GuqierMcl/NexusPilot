import { MysqlIcon } from "@/components/icons/database";

import {
    CreateMysqlDatabaseForm,
    EditMysqlDatabaseForm,
} from "@/features/workbench/explorer/components/database-forms/MySqlDatabaseForms";
import { MySqlConnectionForm } from "@/features/workbench/explorer/components/connection-forms/MySqlConnectionForm";
import {
    createDefaultSshTunnelConfig,
    isValidPort,
    validateAdvancedNetworkConfig,
} from "@/features/workbench/explorer/components/connection-forms/connection-form-utils";
import { relationalCreateDatabaseOperation } from "@/features/workbench/explorer/driver-configs/create-database-operations";
import {
    relationalDatabaseDropOperation,
    relationalTableDropOperation,
} from "@/features/workbench/explorer/driver-configs/schema-drop-operations";
import type {
    DatabaseMutationContext,
    ExplorerDriverConfig,
    MysqlCreateDatabaseFormValue,
    MysqlEditDatabaseFormValue,
} from "@/features/workbench/explorer/driver-configs/types";
import type { ContainerRef, CreateDatabaseInput, UpdateDatabaseInput } from "@/types/ipc";

function getDatabaseContainer(context: DatabaseMutationContext): ContainerRef {
    const node = context.node;
    if (node && "metadata" in node && node.metadata.container) {
        return node.metadata.container;
    }
    throw new Error("未找到数据库节点");
}

export const mysqlDriverConfig: ExplorerDriverConfig<"mysql"> = {
    driver: "mysql",
    displayName: "MySQL",
    pickerDescription: "连接到 MySQL 或 MariaDB 数据库",
    pickerIcon: MysqlIcon,
    category: "rdbms",
    treeVisual: {
        icon: MysqlIcon,
        iconClassName: "text-sky-500",
    },
    connectionModel: "network",
    dropDatabase: relationalDatabaseDropOperation,
    dropTable: relationalTableDropOperation,
    savedQueryContextLevels: ["database"],
    createDatabase: {
        operation: relationalCreateDatabaseOperation,
        createDefaultValue: (): MysqlCreateDatabaseFormValue => ({
            name: "",
            characterSet: "",
        }),
        validate: (value) =>
            value.name?.trim() ? null : "请填写数据库名称",
        buildInput: (value): CreateDatabaseInput => ({
            name: value.name?.trim() ?? "",
            characterSet: value.characterSet?.trim() || null,
        }),
        renderForm: ({ value, onChange, disabled, context }) => (
            <CreateMysqlDatabaseForm
                value={value}
                onChange={onChange}
                disabled={disabled}
                context={context}
            />
        ),
    },
    editDatabase: {
        createDefaultValue: (context): MysqlEditDatabaseFormValue => ({
            characterSet: context.currentDatabaseCharacterSet ?? "",
        }),
        validate: (value) =>
            value.characterSet?.trim() ? null : "请选择字符集",
        buildInput: (value, context): UpdateDatabaseInput => ({
            container: getDatabaseContainer(context),
            characterSet: value.characterSet?.trim() ?? "",
        }),
        renderForm: ({ value, onChange, disabled, context }) => (
            <EditMysqlDatabaseForm
                value={value}
                onChange={onChange}
                disabled={disabled}
                context={context}
            />
        ),
    },
    createDefaultConfig: () => ({
        host: "",
        port: 3306,
        username: "",
        password: "",
        savePassword: false,
        defaultDatabase: "",
        connectTimeoutSeconds: 5,
        sshTunnel: createDefaultSshTunnelConfig(),
        sslMode: "disable" as const,
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
        const advancedError = validateAdvancedNetworkConfig(config);
        if (advancedError) {
            return advancedError;
        }
        if (config.sshTunnel?.enabled && config.sslMode === "verify-identity") {
            return "SSH 隧道暂不支持 MySQL verify-identity 主机名校验";
        }
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <MySqlConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
