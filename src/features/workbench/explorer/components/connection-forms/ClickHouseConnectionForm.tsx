import {
    Field,
    FieldContent,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputPassword } from "@/components/ui/input-password";
import { AdvancedConnectionFields } from "@/features/workbench/explorer/components/connection-forms/AdvancedConnectionFields";
import { ConnectionFormTabs } from "@/features/workbench/explorer/components/connection-forms/ConnectionFormTabs";
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["clickhouse"];

export interface ClickHouseConnectionFormProps {
    value: Value;
    onChange: (value: Value) => void;
    disabled?: boolean;
}

export function ClickHouseConnectionForm({
    value,
    onChange,
    disabled,
}: ClickHouseConnectionFormProps) {
    function patch(partial: Partial<Value>) {
        onChange({ ...value, ...partial });
    }

    return (
        <ConnectionFormTabs
            tabs={[
                {
                    value: "general",
                    label: "常规",
                    content: (
                        <FieldGroup className="gap-4">
                            <Field>
                                <FieldLabel htmlFor="clickhouse-protocol">
                                    连接协议
                                </FieldLabel>
                                <FieldContent>
                                    <select
                                        id="clickhouse-protocol"
                                        disabled={disabled}
                                        value={value.protocol}
                                        onChange={(event) =>
                                            patch({
                                                protocol: event.target
                                                    .value as Value["protocol"],
                                            })
                                        }
                                        className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <option value="http">HTTP</option>
                                        <option value="https">HTTPS</option>
                                    </select>
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="clickhouse-host">主机</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="clickhouse-host"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.host}
                                        onChange={(event) =>
                                            patch({ host: event.target.value })
                                        }
                                        placeholder="例如：127.0.0.1"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="clickhouse-port">HTTP 端口</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="clickhouse-port"
                                        type="text"
                                        inputMode="numeric"
                                        disabled={disabled}
                                        value={
                                            Number.isNaN(value.port)
                                                ? ""
                                                : String(value.port)
                                        }
                                        onChange={(event) => {
                                            const parsed = Number.parseInt(
                                                event.target.value,
                                                10,
                                            );
                                            patch({
                                                port: Number.isNaN(parsed)
                                                    ? 0
                                                    : parsed,
                                            });
                                        }}
                                        placeholder={
                                            value.protocol === "https"
                                                ? "8443"
                                                : "8123"
                                        }
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="clickhouse-username">
                                    用户名
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="clickhouse-username"
                                        autoComplete="username"
                                        disabled={disabled}
                                        value={value.username ?? ""}
                                        onChange={(event) =>
                                            patch({ username: event.target.value })
                                        }
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="clickhouse-password">
                                    密码
                                </FieldLabel>
                                <FieldContent>
                                    <InputPassword
                                        id="clickhouse-password"
                                        autoComplete="current-password"
                                        disabled={disabled}
                                        value={value.password}
                                        onChange={(event) =>
                                            patch({ password: event.target.value })
                                        }
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="clickhouse-default-database">
                                    默认数据库
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="clickhouse-default-database"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.defaultDatabase ?? ""}
                                        onChange={(event) =>
                                            patch({
                                                defaultDatabase: event.target.value,
                                            })
                                        }
                                        placeholder="default"
                                    />
                                </FieldContent>
                            </Field>
                        </FieldGroup>
                    ),
                },
                {
                    value: "advanced",
                    label: "高级",
                    content: (
                        <AdvancedConnectionFields
                            value={value}
                            onChange={onChange}
                            disabled={disabled}
                        />
                    ),
                },
            ]}
        />
    );
}
