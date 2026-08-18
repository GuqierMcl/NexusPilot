import {
    Field,
    FieldContent,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputPassword } from "@/components/ui/input-password";
import { Textarea } from "@/components/ui/textarea";
import { AdvancedConnectionFields } from "@/features/workbench/explorer/components/connection-forms/AdvancedConnectionFields";
import { ConnectionFormTabs } from "@/features/workbench/explorer/components/connection-forms/ConnectionFormTabs";
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["oracle"];

export interface OracleConnectionFormProps {
    value: Value;
    onChange: (value: Value) => void;
    disabled?: boolean;
}

export function OracleConnectionForm({
    value,
    onChange,
    disabled,
}: OracleConnectionFormProps) {
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
                                <FieldLabel htmlFor="oracle-host">主机</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="oracle-host"
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
                                <FieldLabel htmlFor="oracle-port">端口</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="oracle-port"
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
                                        placeholder="1521"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-service-name">
                                    Service Name
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="oracle-service-name"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.serviceName ?? ""}
                                        onChange={(event) =>
                                            patch({
                                                serviceName: event.target.value,
                                            })
                                        }
                                        placeholder="例如：FREEPDB1"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-sid">SID</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="oracle-sid"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.sid ?? ""}
                                        onChange={(event) =>
                                            patch({ sid: event.target.value })
                                        }
                                        placeholder="旧环境可用，Service Name 与 SID 二选一"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-username">
                                    用户名
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="oracle-username"
                                        autoComplete="username"
                                        disabled={disabled}
                                        value={value.username ?? ""}
                                        onChange={(event) =>
                                            patch({
                                                username: event.target.value,
                                            })
                                        }
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-password">
                                    密码
                                </FieldLabel>
                                <FieldContent>
                                    <InputPassword
                                        id="oracle-password"
                                        autoComplete="current-password"
                                        disabled={disabled}
                                        value={value.password}
                                        onChange={(event) =>
                                            patch({
                                                password: event.target.value,
                                            })
                                        }
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-role">角色</FieldLabel>
                                <FieldContent>
                                    <select
                                        id="oracle-role"
                                        disabled={disabled}
                                        value={value.role ?? "normal"}
                                        onChange={(event) =>
                                            patch({
                                                role: event.target
                                                    .value as Value["role"],
                                            })
                                        }
                                        className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <option value="normal">Normal</option>
                                        <option value="sysdba" disabled>
                                            SYSDBA（后续）
                                        </option>
                                        <option value="sysoper" disabled>
                                            SYSOPER（后续）
                                        </option>
                                    </select>
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="oracle-connect-descriptor">
                                    Connect Descriptor
                                </FieldLabel>
                                <FieldContent>
                                    <Textarea
                                        id="oracle-connect-descriptor"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.connectDescriptor ?? ""}
                                        onChange={(event) =>
                                            patch({
                                                connectDescriptor:
                                                    event.target.value,
                                            })
                                        }
                                        placeholder="EZConnect，例如 //host:1521/FREEPDB1"
                                        className="min-h-20 resize-y"
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
