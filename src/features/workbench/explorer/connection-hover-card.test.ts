import { describe, expect, test } from "bun:test";

import { buildConnectionHoverCardModel } from "@/features/workbench/explorer/connection-hover-card";
import type { IStoredConnectionProfile } from "@/types/connections";

type ProfileOverrides = Partial<IStoredConnectionProfile> & {
    driver: IStoredConnectionProfile["driver"];
};

function createProfile(overrides: ProfileOverrides): IStoredConnectionProfile {
    return {
        id: "connection-1",
        name: "订单生产库",
        environment: "production",
        note: "仅用于月末报表\n请勿写入",
        tagLabel: "生产",
        tagColor: "violet",
        createdAt: 1,
        updatedAt: 2,
        host: "db.internal",
        port: 5432,
        username: "analyst",
        password: "database-password-must-not-leak",
        savePassword: true,
        defaultDatabase: "orders",
        schema: "reporting",
        sslMode: "require",
        ...overrides,
    } as IStoredConnectionProfile;
}

describe("connection hover card model", () => {
    test("builds PostgreSQL, MySQL, and ClickHouse location rows", () => {
        expect(buildConnectionHoverCardModel(
            createProfile({ driver: "postgres" }),
            "PostgreSQL",
        )).toEqual({
            name: "订单生产库",
            driverName: "PostgreSQL",
            tag: {
                label: "生产",
                colorLabel: "紫色",
                markerClassName: "bg-violet-500",
            },
            note: "仅用于月末报表\n请勿写入",
            fields: [
                { label: "地址", value: "db.internal:5432" },
                { label: "默认数据库", value: "orders" },
                { label: "Schema", value: "reporting" },
            ],
        });

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "mysql",
                port: 3306,
                defaultDatabase: "inventory",
            }),
            "MySQL",
        ).fields).toEqual([
            { label: "地址", value: "db.internal:3306" },
            { label: "默认数据库", value: "inventory" },
        ]);

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "clickhouse",
                protocol: "https",
                port: 8443,
                defaultDatabase: "analytics",
            }),
            "ClickHouse",
        ).fields).toEqual([
            { label: "地址", value: "https://db.internal:8443" },
            { label: "默认数据库", value: "analytics" },
        ]);
    });

    test("reuses connection tag normalization and omits absent tags", () => {
        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "postgres",
                tagLabel: "  报表库  ",
                tagColor: null,
            }),
            "PostgreSQL",
        ).tag).toEqual({
            label: "报表库",
            colorLabel: "蓝色",
            markerClassName: "bg-sky-500",
        });

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "postgres",
                tagLabel: "",
                tagColor: "emerald",
            }),
            "PostgreSQL",
        ).tag).toEqual({
            label: null,
            colorLabel: "绿色",
            markerClassName: "bg-emerald-500",
        });

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "postgres",
                tagLabel: "",
                tagColor: null,
            }),
            "PostgreSQL",
        ).tag).toBe(null);
    });

    test("shows an explicit Redis zero but omits an unset database index", () => {
        const model = buildConnectionHoverCardModel(
            createProfile({
                driver: "redis",
                port: 6379,
                dbIndex: 0,
                useTLS: false,
            }),
            "Redis",
        );

        expect(model.fields).toEqual([
            { label: "地址", value: "db.internal:6379" },
            { label: "数据库索引", value: "0" },
            { label: "TLS", value: "未启用" },
        ]);

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "redis",
                port: 6379,
                dbIndex: null,
                useTLS: false,
            }),
            "Redis",
        ).fields).toEqual([
            { label: "地址", value: "db.internal:6379" },
            { label: "TLS", value: "未启用" },
        ]);
    });

    test("builds Oracle and SQLite rows without unsafe descriptor data", () => {
        const oracle = buildConnectionHoverCardModel(
            createProfile({
                driver: "oracle",
                port: 1521,
                serviceName: "ORCLPDB1",
                sid: "",
                role: "sysdba",
                connectDescriptor: "oracle-descriptor-must-not-leak",
            }),
            "Oracle Database",
        );
        expect(oracle.fields).toEqual([
            { label: "地址", value: "db.internal:1521" },
            { label: "Service Name", value: "ORCLPDB1" },
            { label: "角色", value: "SYSDBA" },
        ]);
        expect(JSON.stringify(oracle).includes("oracle-descriptor-must-not-leak")).toBe(false);

        const descriptorOnly = buildConnectionHoverCardModel(
            createProfile({
                driver: "oracle",
                host: "",
                port: 1521,
                serviceName: "",
                sid: "",
                role: "normal",
                connectDescriptor: "descriptor-only-target-must-not-leak",
            }),
            "Oracle Database",
        );
        expect(descriptorOnly.fields).toEqual([
            { label: "角色", value: "普通用户" },
        ]);
        expect(JSON.stringify(descriptorOnly).includes("descriptor-only-target-must-not-leak")).toBe(false);

        expect(buildConnectionHoverCardModel(
            createProfile({
                driver: "sqlite",
                dbFilePath: "D:\\data\\orders.db",
                isReadOnly: false,
            }),
            "SQLite",
        ).fields).toEqual([
            { label: "文件路径", value: "D:\\data\\orders.db" },
            { label: "访问模式", value: "读写" },
        ]);
    });

    test("omits blank optional values and represents an empty note", () => {
        const model = buildConnectionHoverCardModel(
            createProfile({
                driver: "postgres",
                note: "",
                defaultDatabase: "  ",
                schema: "",
            }),
            "PostgreSQL",
        );

        expect(model.note).toBe(null);
        expect(model.fields).toEqual([
            { label: "地址", value: "db.internal:5432" },
        ]);
    });

    test("never projects credentials, raw errors, or unknown payload fields", () => {
        const profile = createProfile({
            driver: "postgres",
            password: "database-password-must-not-leak",
            lastConnectionError: "token-from-raw-error-must-not-leak",
            sshTunnel: {
                enabled: true,
                host: "bastion.internal",
                port: 22,
                username: "deployer",
                authMethod: "private-key",
                password: "ssh-password-must-not-leak",
                privateKeyPath: "private-key-path-must-not-leak",
                privateKeyPassphrase: "key-passphrase-must-not-leak",
            },
        }) as IStoredConnectionProfile & {
            apiKey: string;
            nested: { token: string };
        };
        profile.apiKey = "api-key-must-not-leak";
        profile.nested = { token: "unknown-token-must-not-leak" };

        const serialized = JSON.stringify(
            buildConnectionHoverCardModel(profile, "PostgreSQL"),
        );

        for (const secret of [
            "database-password-must-not-leak",
            "token-from-raw-error-must-not-leak",
            "ssh-password-must-not-leak",
            "private-key-path-must-not-leak",
            "key-passphrase-must-not-leak",
            "api-key-must-not-leak",
            "unknown-token-must-not-leak",
        ]) {
            expect(serialized.includes(secret)).toBe(false);
        }
    });
});
