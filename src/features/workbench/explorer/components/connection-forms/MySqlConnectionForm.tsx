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
import { MysqlSslFields } from "@/features/workbench/explorer/components/connection-forms/SslConnectionFields";
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["mysql"];

export type MySqlConnectionFormProps = {
    value: Value;
    onChange: (value: Value) => void;
    disabled?: boolean;
};

export function MySqlConnectionForm({
    value,
    onChange,
    disabled,
}: MySqlConnectionFormProps) {
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
                                <FieldLabel htmlFor="mysql-host">主机</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="mysql-host"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.host}
                                        onChange={(e) => patch({ host: e.target.value })}
                                        placeholder="例如：127.0.0.1"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="mysql-port">端口</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="mysql-port"
                                        type="text"
                                        inputMode="numeric"
                                        disabled={disabled}
                                        value={Number.isNaN(value.port) ? "" : String(value.port)}
                                        onChange={(e) => {
                                            const n = Number.parseInt(e.target.value, 10);
                                            patch({ port: Number.isNaN(n) ? 0 : n });
                                        }}
                                        placeholder="3306"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="mysql-username">用户名</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="mysql-username"
                                        autoComplete="username"
                                        disabled={disabled}
                                        value={value.username ?? ""}
                                        onChange={(e) => patch({ username: e.target.value })}
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="mysql-password">密码</FieldLabel>
                                <FieldContent>
                                    <InputPassword
                                        id="mysql-password"
                                        autoComplete="current-password"
                                        disabled={disabled}
                                        value={value.password}
                                        onChange={(e) => patch({ password: e.target.value })}
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="mysql-default-database">
                                    默认数据库
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="mysql-default-database"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.defaultDatabase ?? ""}
                                        onChange={(e) =>
                                            patch({ defaultDatabase: e.target.value })
                                        }
                                        placeholder="(可选)"
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
                {
                    value: "ssl",
                    label: "SSL",
                    content: (
                        <MysqlSslFields
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
