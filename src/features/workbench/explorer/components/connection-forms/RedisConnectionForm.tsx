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
import { RedisSslFields } from "@/features/workbench/explorer/components/connection-forms/SslConnectionFields";
import type { DriverConfigValueMap } from "@/features/workbench/explorer/driver-configs/types";

type Value = DriverConfigValueMap["redis"];

export type RedisConnectionFormProps = {
    value: Value;
    onChange: (value: Value) => void;
    disabled?: boolean;
};

export function RedisConnectionForm({
    value,
    onChange,
    disabled,
}: RedisConnectionFormProps) {
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
                                <FieldLabel htmlFor="redis-host">主机</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="redis-host"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={value.host}
                                        onChange={(e) => patch({ host: e.target.value })}
                                        placeholder="例如：127.0.0.1"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="redis-port">端口</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="redis-port"
                                        type="text"
                                        inputMode="numeric"
                                        disabled={disabled}
                                        value={Number.isNaN(value.port) ? "" : String(value.port)}
                                        onChange={(e) => {
                                            const n = Number.parseInt(e.target.value, 10);
                                            patch({ port: Number.isNaN(n) ? 0 : n });
                                        }}
                                        placeholder="6379"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="redis-username">用户名</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="redis-username"
                                        autoComplete="username"
                                        disabled={disabled}
                                        value={value.username ?? ""}
                                        onChange={(e) => patch({ username: e.target.value })}
                                        placeholder="(可选)"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="redis-password">密码</FieldLabel>
                                <FieldContent>
                                    <InputPassword
                                        id="redis-password"
                                        autoComplete="current-password"
                                        disabled={disabled}
                                        value={value.password}
                                        onChange={(e) => patch({ password: e.target.value })}
                                        placeholder="(可选)"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="redis-db-index">数据库索引</FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="redis-db-index"
                                        type="text"
                                        inputMode="numeric"
                                        disabled={disabled}
                                        value={
                                            value.dbIndex == null || Number.isNaN(value.dbIndex)
                                                ? ""
                                                : String(value.dbIndex)
                                        }
                                        onChange={(e) => {
                                            if (e.target.value.trim() === "") {
                                                patch({ dbIndex: null });
                                                return;
                                            }
                                            const n = Number.parseInt(e.target.value, 10);
                                            patch({ dbIndex: Number.isNaN(n) ? null : n });
                                        }}
                                        placeholder="留空以获取所有数据库索引"
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
                        <RedisSslFields
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
