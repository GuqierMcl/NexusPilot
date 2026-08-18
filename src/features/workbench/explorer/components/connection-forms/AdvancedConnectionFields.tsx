import {
    Field,
    FieldContent,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputPassword } from "@/components/ui/input-password";
import {
    createDefaultSshTunnelConfig,
    type AdvancedNetworkConfigValue,
} from "@/features/workbench/explorer/components/connection-forms/connection-form-utils";
import type { ISshTunnelConfig } from "@/types";

export interface AdvancedConnectionFieldsProps<
    TValue extends AdvancedNetworkConfigValue,
> {
    value: TValue;
    onChange: (value: TValue) => void;
    disabled?: boolean;
}

function numberInputValue(value: number | undefined): string {
    return value == null || Number.isNaN(value) ? "" : String(value);
}

export function AdvancedConnectionFields<TValue extends AdvancedNetworkConfigValue>({
    value,
    onChange,
    disabled,
}: AdvancedConnectionFieldsProps<TValue>) {
    const sshTunnel = value.sshTunnel ?? createDefaultSshTunnelConfig();

    function patch(partial: Partial<TValue>) {
        onChange({ ...value, ...partial });
    }

    function patchSshTunnel(partial: Partial<ISshTunnelConfig>) {
        patch({
            sshTunnel: {
                ...sshTunnel,
                ...partial,
            },
        } as Partial<TValue>);
    }

    return (
        <FieldGroup className="gap-4">
            <Field>
                <FieldLabel htmlFor="advanced-timeout">连接超时(秒)</FieldLabel>
                <FieldContent>
                    <Input
                        id="advanced-timeout"
                        type="text"
                        inputMode="numeric"
                        disabled={disabled}
                        value={numberInputValue(value.connectTimeoutSeconds)}
                        onChange={(event) => {
                            const text = event.target.value.trim();
                            const parsed = Number.parseInt(text, 10);
                            patch({
                                connectTimeoutSeconds:
                                    text === "" || Number.isNaN(parsed)
                                        ? undefined
                                        : parsed,
                            } as Partial<TValue>);
                        }}
                        placeholder="5"
                    />
                </FieldContent>
            </Field>

            <Field>
                <FieldLabel htmlFor="ssh-enabled">启用 SSH 隧道</FieldLabel>
                <FieldContent>
                    <label
                        htmlFor="ssh-enabled"
                        className="flex cursor-pointer items-center gap-2"
                    >
                        <input
                            id="ssh-enabled"
                            type="checkbox"
                            disabled={disabled}
                            checked={sshTunnel.enabled}
                            onChange={(event) =>
                                patchSshTunnel({ enabled: event.target.checked })
                            }
                            className="accent-primary size-4 cursor-pointer rounded"
                        />
                        <span className="text-sm">SSH</span>
                    </label>
                </FieldContent>
            </Field>

            {sshTunnel.enabled && (
                <>
                    <Field>
                        <FieldLabel htmlFor="ssh-host">SSH 主机</FieldLabel>
                        <FieldContent>
                            <Input
                                id="ssh-host"
                                autoComplete="off"
                                disabled={disabled}
                                value={sshTunnel.host}
                                onChange={(event) =>
                                    patchSshTunnel({ host: event.target.value })
                                }
                                placeholder="例如：bastion.example.com"
                            />
                        </FieldContent>
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="ssh-port">SSH 端口</FieldLabel>
                        <FieldContent>
                            <Input
                                id="ssh-port"
                                type="text"
                                inputMode="numeric"
                                disabled={disabled}
                                value={numberInputValue(sshTunnel.port)}
                                onChange={(event) => {
                                    const parsed = Number.parseInt(
                                        event.target.value,
                                        10,
                                    );
                                    patchSshTunnel({
                                        port: Number.isNaN(parsed) ? 0 : parsed,
                                    });
                                }}
                                placeholder="22"
                            />
                        </FieldContent>
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="ssh-username">SSH 用户名</FieldLabel>
                        <FieldContent>
                            <Input
                                id="ssh-username"
                                autoComplete="username"
                                disabled={disabled}
                                value={sshTunnel.username}
                                onChange={(event) =>
                                    patchSshTunnel({ username: event.target.value })
                                }
                            />
                        </FieldContent>
                    </Field>
                    <Field>
                        <FieldLabel htmlFor="ssh-auth-method">认证方式</FieldLabel>
                        <FieldContent>
                            <select
                                id="ssh-auth-method"
                                disabled={disabled}
                                value={sshTunnel.authMethod}
                                onChange={(event) =>
                                    patchSshTunnel({
                                        authMethod: event.target
                                            .value as ISshTunnelConfig["authMethod"],
                                    })
                                }
                                className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="password">密码</option>
                                <option value="private-key">私钥文件</option>
                            </select>
                        </FieldContent>
                    </Field>
                    {sshTunnel.authMethod === "password" ? (
                        <Field>
                            <FieldLabel htmlFor="ssh-password">SSH 密码</FieldLabel>
                            <FieldContent>
                                <InputPassword
                                    id="ssh-password"
                                    autoComplete="current-password"
                                    disabled={disabled}
                                    value={sshTunnel.password ?? ""}
                                    onChange={(event) =>
                                        patchSshTunnel({
                                            password: event.target.value,
                                        })
                                    }
                                />
                            </FieldContent>
                        </Field>
                    ) : (
                        <>
                            <Field>
                                <FieldLabel htmlFor="ssh-private-key">
                                    私钥文件
                                </FieldLabel>
                                <FieldContent>
                                    <Input
                                        id="ssh-private-key"
                                        autoComplete="off"
                                        disabled={disabled}
                                        value={sshTunnel.privateKeyPath ?? ""}
                                        onChange={(event) =>
                                            patchSshTunnel({
                                                privateKeyPath: event.target.value,
                                            })
                                        }
                                        placeholder="C:\\Users\\me\\.ssh\\id_ed25519"
                                    />
                                </FieldContent>
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="ssh-private-key-passphrase">
                                    私钥密码
                                </FieldLabel>
                                <FieldContent>
                                    <InputPassword
                                        id="ssh-private-key-passphrase"
                                        autoComplete="current-password"
                                        disabled={disabled}
                                        value={sshTunnel.privateKeyPassphrase ?? ""}
                                        onChange={(event) =>
                                            patchSshTunnel({
                                                privateKeyPassphrase:
                                                    event.target.value,
                                            })
                                        }
                                    />
                                </FieldContent>
                            </Field>
                        </>
                    )}
                    <Field>
                        <FieldLabel htmlFor="ssh-host-verification">
                            主机校验
                        </FieldLabel>
                        <FieldContent>
                            <select
                                id="ssh-host-verification"
                                disabled={disabled}
                                value={
                                    sshTunnel.hostVerification
                                    ?? "trust-on-first-use"
                                }
                                onChange={(event) =>
                                    patchSshTunnel({
                                        hostVerification: event.target
                                            .value as ISshTunnelConfig["hostVerification"],
                                    })
                                }
                                className="border-input bg-background text-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="trust-on-first-use">首次信任</option>
                                <option value="skip">跳过校验</option>
                            </select>
                        </FieldContent>
                    </Field>
                </>
            )}
        </FieldGroup>
    );
}
