import type { ISshTunnelConfig } from "@/types";

export interface AdvancedNetworkConfigValue {
    connectTimeoutSeconds?: number;
    sshTunnel?: ISshTunnelConfig;
}

export function createDefaultSshTunnelConfig(): ISshTunnelConfig {
    return {
        enabled: false,
        host: "",
        port: 22,
        username: "",
        authMethod: "password",
        password: "",
        privateKeyPath: "",
        privateKeyPassphrase: "",
        hostVerification: "trust-on-first-use",
        hostKeyFingerprint: null,
    };
}

export function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isValidConnectTimeout(value: number | undefined): boolean {
    return value == null || (Number.isInteger(value) && value >= 1 && value <= 300);
}

export function validateAdvancedNetworkConfig(
    config: AdvancedNetworkConfigValue,
): string | null {
    if (!isValidConnectTimeout(config.connectTimeoutSeconds)) {
        return "连接超时必须是 1-300 秒之间的整数";
    }

    const ssh = config.sshTunnel;
    if (!ssh?.enabled) {
        return null;
    }
    if (!ssh.host.trim()) {
        return "请填写 SSH 主机地址";
    }
    if (!isValidPort(ssh.port)) {
        return "SSH 端口必须是 1-65535 之间的整数";
    }
    if (!ssh.username.trim()) {
        return "请填写 SSH 用户名";
    }
    if (ssh.authMethod === "password" && !ssh.password?.trim()) {
        return "请填写 SSH 密码";
    }
    if (ssh.authMethod === "private-key" && !ssh.privateKeyPath?.trim()) {
        return "请选择 SSH 私钥文件";
    }
    return null;
}
