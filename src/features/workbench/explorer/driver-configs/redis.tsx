import { RedisIcon } from "@/components/icons/database";

import {
    createDefaultSshTunnelConfig,
    isValidPort,
    validateAdvancedNetworkConfig,
} from "@/features/workbench/explorer/components/connection-forms/connection-form-utils";
import { RedisConnectionForm } from "@/features/workbench/explorer/components/connection-forms/RedisConnectionForm";
import type { ExplorerDriverConfig } from "@/features/workbench/explorer/driver-configs/types";

export const redisDriverConfig: ExplorerDriverConfig<"redis"> = {
    driver: "redis",
    displayName: "Redis",
    pickerDescription: "连接到 Redis 数据库",
    pickerIcon: RedisIcon,
    category: "key-value",
    treeVisual: {
        icon: RedisIcon,
        iconClassName: "text-red-500",
    },
    connectionModel: "network",
    savedQueryContextLevels: [],
    createDefaultConfig: () => ({
        host: "",
        port: 6379,
        username: "",
        password: "",
        savePassword: false,
        dbIndex: null,
        connectTimeoutSeconds: 5,
        sshTunnel: createDefaultSshTunnelConfig(),
        useTLS: false,
    }),
    validate: (config) => {
        if (!config.host.trim()) {
            return "请填写主机地址";
        }
        if (!isValidPort(config.port)) {
            return "端口必须是 1–65535 之间的整数";
        }
        if (
            config.dbIndex != null
            && (!Number.isInteger(config.dbIndex)
                || config.dbIndex < 0
                || config.dbIndex > 255)
        ) {
            return "数据库索引必须是 0–255 之间的整数";
        }
        const advancedError = validateAdvancedNetworkConfig(config);
        if (advancedError) {
            return advancedError;
        }
        return null;
    },
    renderForm: ({ value, onChange, disabled }) => (
        <RedisConnectionForm
            value={value}
            onChange={onChange}
            disabled={disabled}
        />
    ),
};
