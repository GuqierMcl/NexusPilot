import { Copy, Database } from "lucide-react";

import { clickhouseDriverConfig } from "@/features/workbench/explorer/driver-configs/clickhouse";
import { mysqlDriverConfig } from "@/features/workbench/explorer/driver-configs/mysql";
import { oracleDriverConfig } from "@/features/workbench/explorer/driver-configs/oracle";
import { postgresDriverConfig } from "@/features/workbench/explorer/driver-configs/postgres";
import { redisDriverConfig } from "@/features/workbench/explorer/driver-configs/redis";
import { sqliteDriverConfig } from "@/features/workbench/explorer/driver-configs/sqlite";
import type {
    AnyExplorerDriverConfig,
    ConnectionModel,
    DriverContextMenuGroup,
    DriverContextMenuItem,
    ExplorerDriverConfig,
    ImplementedDriver,
} from "@/features/workbench/explorer/driver-configs/types";
import type { DbDriver } from "@/types";

/**
 * 仅包含已实现的驱动。
 * 使用 Partial<Record<DbDriver, ...>> 而非要求全量覆盖，
 * 防止 TypeScript 在新增 DbDriver 时报错"缺少实现"。
 */
type DriverConfigRegistry = {
    [K in ImplementedDriver]: ExplorerDriverConfig<K>;
};

export const DRIVER_CONFIGS: DriverConfigRegistry = {
    clickhouse: clickhouseDriverConfig,
    mysql: mysqlDriverConfig,
    postgres: postgresDriverConfig,
    oracle: oracleDriverConfig,
    redis: redisDriverConfig,
    sqlite: sqliteDriverConfig,
};

// ─── 物理连接模型通用菜单项 ────────────────────────────────────────────────────
// actionId 格式：model.<model>.<action>
// WorkbenchExplorerPanel.handleDriverMenuAction 按此前缀统一分发处理。

const MODEL_MENU_ITEMS: Record<ConnectionModel, DriverContextMenuItem[]> = {
    network: [
        {
            key: "model-copy-host",
            label: "复制 Host",
            actionId: "model.network.copyHost",
            icon: Copy,
        },
        {
            key: "model-copy-port",
            label: "复制端口",
            actionId: "model.network.copyPort",
            icon: Copy,
        },
        {
            key: "model-copy-username",
            label: "复制用户名",
            actionId: "model.network.copyUsername",
            icon: Copy,
        },
    ],
    "local-file": [
        {
            key: "model-copy-path",
            label: "复制文件路径",
            actionId: "model.local-file.copyPath",
            icon: Copy,
        },
    ],
    "cloud-api": [
        {
            key: "model-copy-endpoint",
            label: "复制 Endpoint",
            actionId: "model.cloud-api.copyEndpoint",
            icon: Copy,
        },
    ],
};

const FALLBACK_CONTEXT_MENU_GROUP: DriverContextMenuGroup = {
    label: "数据库选项",
    items: [
        {
            key: "generic-placeholder",
            label: "数据库菜单占位项",
            actionId: "driver.generic",
            disabled: true,
        },
    ],
};

// ─── 菜单构建函数 ──────────────────────────────────────────────────────────────

/**
 * 根据驱动配置构建最终的右键菜单组。
 *
 * 菜单条目顺序：模型通用条目（由 connectionModel 自动注入）→ 驱动独有条目（driverMenuItems）。
 */
export function buildDriverContextMenu(
    config: AnyExplorerDriverConfig,
): DriverContextMenuGroup {
    const modelItems = MODEL_MENU_ITEMS[config.connectionModel] ?? [];
    const driverItems = config.driverMenuItems ?? [];
    return {
        label: config.displayName,
        items: [...modelItems, ...driverItems],
    };
}

// ─── 公共查询函数 ──────────────────────────────────────────────────────────────

export function listDriverConfigs(): AnyExplorerDriverConfig[] {
    return Object.values(DRIVER_CONFIGS);
}

export function getDriverConfig<TDriver extends ImplementedDriver>(
    driver: TDriver,
): ExplorerDriverConfig<TDriver>;
export function getDriverConfig(
    driver: DbDriver,
): AnyExplorerDriverConfig | undefined;
export function getDriverConfig(
    driver: DbDriver,
): AnyExplorerDriverConfig | undefined {
    return DRIVER_CONFIGS[driver as ImplementedDriver] as AnyExplorerDriverConfig | undefined;
}

/** @deprecated 使用 `buildDriverContextMenu(getDriverConfig(driver))` 替代。 */
export function getDriverContextMenuGroup(driver: DbDriver): DriverContextMenuGroup {
    const config = DRIVER_CONFIGS[driver as ImplementedDriver];
    if (!config) return FALLBACK_CONTEXT_MENU_GROUP;
    return buildDriverContextMenu(config as AnyExplorerDriverConfig);
}

export function getFallbackTreeVisual() {
    return {
        icon: Database,
        iconClassName: "text-slate-500",
    };
}

export { FALLBACK_CONTEXT_MENU_GROUP };
