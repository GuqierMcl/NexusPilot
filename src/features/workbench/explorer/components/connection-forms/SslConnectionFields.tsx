import {
    Field,
    FieldContent,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import type { IMysqlPayload, IPostgresPayload, IRedisPayload } from "@/types";

type PostgresSslMode = NonNullable<IPostgresPayload["sslMode"]>;
type MysqlSslMode = NonNullable<IMysqlPayload["sslMode"]>;

const POSTGRES_SSL_MODES: { value: PostgresSslMode; label: string }[] = [
    { value: "disable", label: "Disable" },
    { value: "require", label: "Require" },
    { value: "verify-ca", label: "Verify CA" },
    { value: "verify-full", label: "Verify Full" },
];

const MYSQL_SSL_MODES: { value: MysqlSslMode; label: string }[] = [
    { value: "disable", label: "Disable" },
    { value: "require", label: "Require" },
    { value: "verify-ca", label: "Verify CA" },
    { value: "verify-identity", label: "Verify Identity" },
];

export function PostgresSslFields({
    value,
    onChange,
    disabled,
}: {
    value: Omit<IPostgresPayload, "driver">;
    onChange: (value: Omit<IPostgresPayload, "driver">) => void;
    disabled?: boolean;
}) {
    return (
        <FieldGroup className="gap-4">
            <Field>
                <FieldLabel htmlFor="pg-ssl-mode">SSL 模式</FieldLabel>
                <FieldContent>
                    <select
                        id="pg-ssl-mode"
                        disabled={disabled}
                        value={value.sslMode ?? "disable"}
                        onChange={(event) =>
                            onChange({
                                ...value,
                                sslMode: event.target.value as PostgresSslMode,
                            })
                        }
                        className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {POSTGRES_SSL_MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                                {mode.label}
                            </option>
                        ))}
                    </select>
                </FieldContent>
            </Field>
        </FieldGroup>
    );
}

export function MysqlSslFields({
    value,
    onChange,
    disabled,
}: {
    value: Omit<IMysqlPayload, "driver">;
    onChange: (value: Omit<IMysqlPayload, "driver">) => void;
    disabled?: boolean;
}) {
    return (
        <FieldGroup className="gap-4">
            <Field>
                <FieldLabel htmlFor="mysql-ssl-mode">SSL 模式</FieldLabel>
                <FieldContent>
                    <select
                        id="mysql-ssl-mode"
                        disabled={disabled}
                        value={value.sslMode ?? "disable"}
                        onChange={(event) =>
                            onChange({
                                ...value,
                                sslMode: event.target.value as MysqlSslMode,
                            })
                        }
                        className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {MYSQL_SSL_MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                                {mode.label}
                            </option>
                        ))}
                    </select>
                </FieldContent>
            </Field>
        </FieldGroup>
    );
}

export function RedisSslFields({
    value,
    onChange,
    disabled,
}: {
    value: Omit<IRedisPayload, "driver">;
    onChange: (value: Omit<IRedisPayload, "driver">) => void;
    disabled?: boolean;
}) {
    return (
        <FieldGroup className="gap-4">
            <Field>
                <FieldLabel htmlFor="redis-use-tls">启用 TLS</FieldLabel>
                <FieldContent>
                    <label
                        htmlFor="redis-use-tls"
                        className="flex cursor-pointer items-center gap-2"
                    >
                        <input
                            id="redis-use-tls"
                            type="checkbox"
                            disabled={disabled}
                            checked={value.useTLS ?? false}
                            onChange={(event) =>
                                onChange({
                                    ...value,
                                    useTLS: event.target.checked,
                                })
                            }
                            className="accent-primary size-4 cursor-pointer rounded"
                        />
                        <span className="text-sm">TLS</span>
                    </label>
                </FieldContent>
            </Field>
        </FieldGroup>
    );
}
