import { getConnectionTagRenderModel } from "@/features/workbench/explorer/connection-tags";
import type { IStoredConnectionProfile } from "@/types/connections";

export interface ConnectionHoverCardField {
    label: string;
    value: string;
}

export interface ConnectionHoverCardTag {
    label: string | null;
    colorLabel: string;
    markerClassName: string;
}

export interface ConnectionHoverCardModel {
    name: string;
    driverName: string;
    tag: ConnectionHoverCardTag | null;
    note: string | null;
    fields: ConnectionHoverCardField[];
}

function nonBlank(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return normalized.length > 0 ? normalized : null;
}

function networkAddress(host: string, port: number): string | null {
    const trimmedHost = host.trim();
    if (trimmedHost.length === 0) {
        return null;
    }
    const normalizedHost = trimmedHost.includes(":") && !trimmedHost.startsWith("[")
        ? `[${trimmedHost}]`
        : trimmedHost;
    return `${normalizedHost}:${port}`;
}

function optionalField(
    label: string,
    value: string | null | undefined,
): ConnectionHoverCardField | null {
    const normalized = nonBlank(value);
    return normalized == null ? null : { label, value: normalized };
}

function compactFields(
    fields: Array<ConnectionHoverCardField | null>,
): ConnectionHoverCardField[] {
    return fields.filter((field): field is ConnectionHoverCardField => field != null);
}

export function buildConnectionHoverCardModel(
    connection: IStoredConnectionProfile,
    driverName: string,
): ConnectionHoverCardModel {
    let fields: ConnectionHoverCardField[];

    switch (connection.driver) {
        case "postgres":
            fields = compactFields([
                optionalField("地址", networkAddress(connection.host, connection.port)),
                optionalField("默认数据库", connection.defaultDatabase),
                optionalField("Schema", connection.schema),
            ]);
            break;
        case "mysql":
            fields = compactFields([
                optionalField("地址", networkAddress(connection.host, connection.port)),
                optionalField("默认数据库", connection.defaultDatabase),
            ]);
            break;
        case "redis":
            fields = compactFields([
                optionalField("地址", networkAddress(connection.host, connection.port)),
                connection.dbIndex == null
                    ? null
                    : { label: "数据库索引", value: String(connection.dbIndex) },
                { label: "TLS", value: connection.useTLS ? "启用" : "未启用" },
            ]);
            break;
        case "oracle": {
            const serviceName = optionalField("Service Name", connection.serviceName);
            const sid = serviceName == null ? optionalField("SID", connection.sid) : null;
            const role = connection.role ?? "normal";
            fields = compactFields([
                optionalField("地址", networkAddress(connection.host, connection.port)),
                serviceName,
                sid,
                {
                    label: "角色",
                    value: role === "normal" ? "普通用户" : role.toUpperCase(),
                },
            ]);
            break;
        }
        case "sqlite":
            fields = [
                { label: "文件路径", value: connection.dbFilePath },
                {
                    label: "访问模式",
                    value: (connection.isReadOnly ?? true) ? "只读" : "读写",
                },
            ];
            break;
        case "clickhouse": {
            const address = networkAddress(connection.host, connection.port);
            fields = compactFields([
                optionalField(
                    "地址",
                    address == null ? null : `${connection.protocol}://${address}`,
                ),
                optionalField("默认数据库", connection.defaultDatabase),
            ]);
            break;
        }
        default:
            fields = [];
    }

    const tagModel = getConnectionTagRenderModel({
        tagLabel: connection.tagLabel,
        tagColor: connection.tagColor,
    });
    const tag = tagModel.kind === "none"
        ? null
        : {
              label: tagModel.kind === "pill" ? tagModel.label : null,
              colorLabel: tagModel.color.label,
              markerClassName: tagModel.color.markerClassName,
          };

    return {
        name: connection.name,
        driverName,
        tag,
        note: nonBlank(connection.note) == null ? null : connection.note,
        fields,
    };
}
