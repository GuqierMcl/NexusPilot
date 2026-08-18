import { PostgresIcon } from "@/components/icons/database";

import {
    CreatePostgresDatabaseForm,
    EditPostgresDatabaseForm,
} from "@/features/workbench/explorer/components/database-forms/PostgresDatabaseForms";
import { PostgresConnectionForm } from "@/features/workbench/explorer/components/connection-forms/PostgresConnectionForm";
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
    PostgresCreateDatabaseFormValue,
    PostgresEditDatabaseFormValue,
} from "@/features/workbench/explorer/driver-configs/types";
import type { ContainerRef, CreateDatabaseInput, UpdateDatabaseInput } from "@/types/ipc";

function getDatabaseContainer(context: DatabaseMutationContext): ContainerRef {
    const node = context.node;
    if (node && "metadata" in node && node.metadata.container) {
        return node.metadata.container;
    }
    throw new Error("未找到数据库节点");
}

function getDatabaseName(context: DatabaseMutationContext): string {
    const container = getDatabaseContainer(context);
    return container.database ?? context.node?.label ?? "";
}

export const postgresDriverConfig: ExplorerDriverConfig<"postgres"> = {
    driver: "postgres",
    displayName: "PostgreSQL",
    pickerDescription: "连接到 PostgreSQL 数据库",
    pickerIcon: PostgresIcon,
    category: "rdbms",
    treeVisual: {
        icon: PostgresIcon,
        iconClassName: "text-indigo-500",
    },
    connectionModel: "network",
    dropDatabase: relationalDatabaseDropOperation,
    dropTable: relationalTableDropOperation,
    savedQueryContextLevels: ["schema"],
    createDatabase: {
        operation: relationalCreateDatabaseOperation,
        createDefaultValue: (): PostgresCreateDatabaseFormValue => ({ name: "" }),
        validate: (value) =>
            value.name?.trim() ? null : "请填写数据库名称",
        buildInput: (value): CreateDatabaseInput => ({
            name: value.name?.trim() ?? "",
        }),
        renderForm: ({ value, onChange, disabled }) => (
            <CreatePostgresDatabaseForm
                value={value}
                onChange={onChange}
                disabled={disabled}
            />
        ),
    },
    editDatabase: {
        createDefaultValue: (context): PostgresEditDatabaseFormValue => ({
            name: getDatabaseName(context),
            comment: "",
            tablespace: "",
        }),
        validate: (value, context) => {
            const name = value.name?.trim() ?? "";
            const comment = value.comment?.trim() ?? "";
            const tablespace = value.tablespace?.trim() ?? "";
            if (!name) {
                return "请填写数据库名称";
            }
            const originalName = getDatabaseName(context);
            const hasRename = name !== originalName;
            const hasComment = comment.length > 0;
            const hasTablespace = tablespace.length > 0;
            return hasRename || hasComment || hasTablespace
                ? null
                : "请至少修改一个数据库属性";
        },
        buildInput: (value, context): UpdateDatabaseInput => {
            const originalName = getDatabaseName(context);
            const name = value.name?.trim() ?? "";
            const comment = value.comment?.trim() ?? "";
            const tablespace = value.tablespace?.trim() ?? "";
            return {
                container: getDatabaseContainer(context),
                name: name && name !== originalName ? name : null,
                comment: comment || null,
                tablespace: tablespace || null,
            };
        },
        renderForm: ({ value, onChange, disabled, context }) => (
            <EditPostgresDatabaseForm
                value={value}
                onChange={onChange}
                disabled={disabled}
                context={context}
            />
        ),
    },
    createDefaultConfig: () => ({
        host: "",
        port: 5432,
        defaultDatabase: "",
        username: "",
        password: "",
        savePassword: false,
        schema: "",
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
        if (config.sshTunnel?.enabled && config.sslMode === "verify-full") {
            return "SSH 隧道暂不支持 PostgreSQL verify-full 主机名校验";
        }
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <PostgresConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
