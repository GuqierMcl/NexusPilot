import { OracleIcon } from "@/components/icons/database";

import { OracleConnectionForm } from "@/features/workbench/explorer/components/connection-forms/OracleConnectionForm";
import {
    createDefaultSshTunnelConfig,
    isValidPort,
    validateAdvancedNetworkConfig,
} from "@/features/workbench/explorer/components/connection-forms/connection-form-utils";
import {
    relationalDatabaseDropOperation,
    relationalTableDropOperation,
} from "@/features/workbench/explorer/driver-configs/schema-drop-operations";
import type { ExplorerDriverConfig } from "@/features/workbench/explorer/driver-configs/types";

export const oracleDriverConfig: ExplorerDriverConfig<"oracle"> = {
    driver: "oracle",
    displayName: "Oracle Database",
    pickerDescription: "连接到 Oracle Database 服务或 SID",
    pickerIcon: OracleIcon,
    category: "rdbms",
    treeVisual: {
        icon: OracleIcon,
        iconClassName: "text-red-500",
    },
    connectionModel: "network",
    dropDatabase: relationalDatabaseDropOperation,
    dropTable: relationalTableDropOperation,
    savedQueryContextLevels: ["schema"],
    createDefaultConfig: () => ({
        host: "",
        port: 1521,
        username: "",
        password: "",
        savePassword: false,
        serviceName: "",
        sid: "",
        connectDescriptor: "",
        role: "normal" as const,
        connectTimeoutSeconds: 5,
        sshTunnel: createDefaultSshTunnelConfig(),
    }),
    validate: (config) => {
        const descriptor = config.connectDescriptor?.trim() ?? "";
        const serviceName = config.serviceName?.trim() ?? "";
        const sid = config.sid?.trim() ?? "";

        if (!descriptor && !config.host.trim()) {
            return "请填写主机地址";
        }
        if (!descriptor && !isValidPort(config.port)) {
            return "端口必须是 1–65535 之间的整数";
        }
        if (!config.username?.trim()) {
            return "请填写用户名";
        }
        if (!descriptor && !serviceName && !sid) {
            return "请填写 Service Name、SID 或 Connect Descriptor";
        }
        if (serviceName && sid) {
            return "Service Name 和 SID 只能填写一个";
        }
        if (descriptor && config.sshTunnel?.enabled) {
            return "Connect Descriptor 暂不能与 SSH Tunnel 同时使用，请关闭 SSH Tunnel 或改用 Service Name/SID";
        }
        if ((config.role ?? "normal") !== "normal") {
            return "暂不支持 SYSDBA/SYSOPER 角色，请改用普通用户连接";
        }
        const advancedError = validateAdvancedNetworkConfig(config);
        if (advancedError) {
            return advancedError;
        }
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <OracleConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
