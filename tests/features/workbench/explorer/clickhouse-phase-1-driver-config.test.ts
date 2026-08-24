import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { clickhouseDriverConfig } from "../../../../src/features/workbench/explorer/driver-configs/clickhouse";

const readSource = (path: string) => readFileSync(path, "utf8");

describe("ClickHouse Phase 1 driver config", () => {
    test("creates HTTP defaults with a disabled SSH tunnel", () => {
        expect(clickhouseDriverConfig.createDefaultConfig()).toEqual({
            host: "",
            port: 8123,
            username: "default",
            password: "",
            savePassword: false,
            defaultDatabase: "default",
            protocol: "http",
            connectTimeoutSeconds: 5,
            sshTunnel: {
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
            },
        });
    });

    test("validates required network and protocol fields", () => {
        const valid = {
            ...clickhouseDriverConfig.createDefaultConfig(),
            host: "localhost",
        };

        expect(clickhouseDriverConfig.validate(valid)).toBeNull();
        expect(
            clickhouseDriverConfig.validate({ ...valid, host: " " }),
        ).toBe("请填写主机地址");
        expect(clickhouseDriverConfig.validate({ ...valid, port: 0 })).toBe(
            "端口必须是 1–65535 之间的整数",
        );
        expect(
            clickhouseDriverConfig.validate({ ...valid, username: " " }),
        ).toBe("请填写用户名");
        expect(
            clickhouseDriverConfig.validate({
                ...valid,
                protocol: "native" as "http",
            }),
        ).toBe("连接协议必须是 HTTP 或 HTTPS");
        expect(
            clickhouseDriverConfig.validate({
                ...valid,
                connectTimeoutSeconds: 0,
            }),
        ).toBe("连接超时必须是 1-300 秒之间的整数");
    });

    test("rejects HTTPS over SSH until original-host SNI routing exists", () => {
        const config = clickhouseDriverConfig.createDefaultConfig();
        expect(
            clickhouseDriverConfig.validate({
                ...config,
                host: "cloud.example.com",
                protocol: "https",
                sshTunnel: {
                    ...config.sshTunnel,
                    enabled: true,
                    host: "bastion.example.com",
                    username: "ops",
                    password: "secret",
                },
            }),
        ).toBe(
            "HTTPS over SSH is unavailable until the tunnel preserves the original ClickHouse hostname for TLS SNI verification",
        );
    });

    test("registers a network driver and dedicated connection form", () => {
        const typesSource = readSource(
            "src/features/workbench/explorer/driver-configs/types.ts",
        );
        const registrySource = readSource(
            "src/features/workbench/explorer/driver-configs/index.ts",
        );
        const formSource = readSource(
            "src/features/workbench/explorer/components/connection-forms/ClickHouseConnectionForm.tsx",
        );
        const connectionTypesSource = readSource("src/types/connections.ts");

        expect(clickhouseDriverConfig.driver).toBe("clickhouse");
        expect(clickhouseDriverConfig.connectionModel).toBe("network");
        expect(clickhouseDriverConfig.category).toBe("analytics");
        expect(typesSource).toMatch(
            /clickhouse:\s+Omit<IClickHousePayload,\s+"driver">;/,
        );
        expect(registrySource).toContain("clickhouseDriverConfig");
        expect(registrySource).toContain("clickhouse: clickhouseDriverConfig");
        expect(connectionTypesSource).toContain("IClickHousePayload");
        expect(formSource).toContain('htmlFor="clickhouse-protocol"');
        expect(formSource).toContain('htmlFor="clickhouse-host"');
        expect(formSource).toContain('htmlFor="clickhouse-default-database"');
        expect(formSource).toContain("AdvancedConnectionFields");
        expect(formSource).not.toContain("skip TLS");
    });

    test("exposes ClickHouse in the desktop picker and public support matrix", () => {
        const pickerSource = readSource(
            "src/features/workbench/explorer/components/SelectDatabaseTypeDialog.tsx",
        );
        const productSource = readSource("sites/product/src/shared/config/product.ts");

        expect(pickerSource).toContain('driver: "clickhouse"');
        expect(pickerSource).toContain('displayName: "ClickHouse"');
        expect(pickerSource).toContain('category: "analytics"');
        expect(pickerSource).toContain('badge: "NEW"');
        expect(productSource).toContain('name: "ClickHouse"');
        expect(productSource).toContain('status: "available"');
    });
});
