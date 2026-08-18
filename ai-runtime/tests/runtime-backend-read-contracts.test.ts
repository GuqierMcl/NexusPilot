import { describe, expect, test } from "bun:test";
import {
  connectionGetResponseSchema,
  connectionListResponseSchema,
  connectionOpenRequestSchema,
  connectionOpenResponseSchema,
  keyValueGetRequestSchema,
  keyValueGetResponseSchema,
  keyValueScanRequestSchema,
  keyValueScanResponseSchema,
  metadataDescribeTableRequestSchema,
  metadataListChildrenRequestSchema,
  metadataListChildrenResponseSchema,
  tableQueryRequestSchema,
  tableQueryResponseSchema,
} from "../src/runtime";

describe("Backend read Tool contracts", () => {
  test("accepts the approved non-secret connection projections", () => {
    expect(connectionListResponseSchema.parse({
      connections: [{
        profileId: "profile-1",
        name: "Primary",
        driver: "mysql",
        environment: "development",
        location: {
          host: "10.0.0.8",
          port: 3306,
          username: "developer",
          defaultDatabase: "app",
        },
        connected: true,
      }],
    })).toBeTruthy();

    expect(connectionGetResponseSchema.parse({
      connection: {
        profileId: "profile-1",
        name: "Primary",
        driver: "mysql",
        environment: "development",
        settings: {
          host: "10.0.0.8",
          port: 3306,
          username: "developer",
          defaultDatabase: "app",
          sslMode: "require",
          sshTunnel: {
            enabled: true,
            host: "jump.example.com",
            port: 22,
            username: "ops",
            authMethod: "private-key",
            hostVerification: "trust-on-first-use",
            hostKeyFingerprint: "SHA256:safe-fingerprint",
          },
        },
        connected: true,
        runtime: {
          driverName: "mysql",
          healthStatus: "healthy",
          availableCapabilities: ["schema_browser", "sql_executor"],
          consecutiveFailures: 0,
          lastSuccessAtMs: 100,
          lastFailureAtMs: null,
          lastErrorCode: null,
        },
        color: "#123456",
        tagLabel: "核心",
        tagColor: "violet",
        folderId: "folder-1",
        sortOrder: 4,
        createdAt: 10,
        updatedAt: 20,
        lastConnectedAt: 30,
        lastConnectionStatus: "connected",
      },
    })).toBeTruthy();
  });

  test("rejects secret-bearing and unknown connection fields", () => {
    const base = {
      profileId: "profile-1",
      name: "Primary",
      driver: "mysql",
      environment: "development",
      settings: {},
      connected: false,
      runtime: null,
      color: null,
      tagLabel: "",
      tagColor: null,
      folderId: null,
      sortOrder: null,
      createdAt: 10,
      updatedAt: 20,
      lastConnectedAt: null,
      lastConnectionStatus: null,
    };

    expect(connectionGetResponseSchema.safeParse({
      connection: {
        ...base,
        settings: { password: "database-secret" },
      },
    }).success).toBe(false);
    expect(connectionGetResponseSchema.safeParse({
      connection: {
        ...base,
        settings: {
          sshTunnel: { privateKeyPath: "C:\\keys\\id_ed25519" },
        },
      },
    }).success).toBe(false);
    expect(connectionGetResponseSchema.safeParse({
      connection: {
        ...base,
        lastConnectionError: "password=secret",
      },
    }).success).toBe(false);
  });

  test("models connection.open as an idempotent shared-runtime result", () => {
    expect(connectionOpenRequestSchema.parse({
      profileId: "profile-1",
    })).toEqual({
      profileId: "profile-1",
    });
    expect(connectionOpenRequestSchema.safeParse({
      profileId: "profile-1",
      password: "must-not-cross-the-tool-boundary",
    }).success).toBe(false);

    expect(connectionOpenResponseSchema.parse({
      connection: {
        profileId: "profile-1",
        name: "Primary",
        driver: "mysql",
        connected: true,
        runtime: {
          driverName: "mysql",
          healthStatus: "healthy",
          availableCapabilities: ["schema_browser", "sql_executor"],
          consecutiveFailures: 0,
          lastSuccessAtMs: 100,
          lastFailureAtMs: null,
          lastErrorCode: null,
        },
      },
      wasAlreadyOpen: false,
    })).toBeTruthy();
  });

  test("applies bounded metadata pagination defaults", () => {
    expect(metadataListChildrenRequestSchema.parse({
      profileId: "profile-1",
    })).toEqual({
      profileId: "profile-1",
      offset: 0,
      limit: 100,
    });
    expect(metadataListChildrenRequestSchema.safeParse({
      profileId: "profile-1",
      limit: 201,
    }).success).toBe(false);
    expect(metadataListChildrenResponseSchema.parse({
      children: [],
      total: 0,
    })).toEqual({
      children: [],
      total: 0,
    });
  });

  test("requires metadata parent to remain a structured ContainerRef", () => {
    const parent = {
      kind: "database" as const,
      database: "app",
    };

    expect(metadataListChildrenRequestSchema.safeParse({
      profileId: "profile-1",
      parent,
    }).success).toBe(true);
    expect(metadataListChildrenRequestSchema.safeParse({
      profileId: "profile-1",
      parent: JSON.stringify(parent),
    }).success).toBe(false);
  });

  test("requires metadata.describe_table to target an exact ContainerRef", () => {
    const result = metadataDescribeTableRequestSchema.safeParse({
      profileId: "profile-1",
      container: {
        kind: "table",
        database: "app",
        schema: "public",
        table: "users",
      },
    });

    expect(result.success).toBe(true);
    expect(metadataDescribeTableRequestSchema.safeParse({
      profileId: "profile-1",
      container: {
        kind: "view",
        database: "app",
        schema: "public",
        table: "active_users",
      },
    }).success).toBe(false);
  });

  test("models table.query as a bounded semantic query without SQL text", () => {
    const request = tableQueryRequestSchema.parse({
      profileId: "profile-1",
      source: {
        kind: "view",
        database: "app",
        schema: "public",
        table: "active_users",
      },
      columns: ["id", "name"],
      filters: [
        { column: "active", operator: "eq", value: true },
        { column: "deleted_at", operator: "is_null" },
      ],
      sort: [{ column: "id", direction: "desc" }],
    });

    expect(request).toMatchObject({
      page: 1,
      pageSize: 50,
      filters: [
        { column: "active", operator: "eq", value: true },
        { column: "deleted_at", operator: "is_null" },
      ],
    });
    expect(tableQueryRequestSchema.safeParse({
      ...request,
      sql: "SELECT * FROM users",
    }).success).toBe(false);
    expect(tableQueryRequestSchema.safeParse({
      ...request,
      filters: [{ column: "id", operator: "eq", value: null }],
    }).success).toBe(false);
    expect(tableQueryRequestSchema.safeParse({
      ...request,
      source: { kind: "key", key: "users" },
    }).success).toBe(false);
    expect(tableQueryRequestSchema.safeParse({
      ...request,
      columns: ["id", "id"],
    }).success).toBe(false);
    expect(tableQueryRequestSchema.safeParse({
      ...request,
      sort: [
        { column: "id", direction: "asc" },
        { column: "id", direction: "desc" },
      ],
    }).success).toBe(false);
  });

  test("accepts compact table.query results and JSON-safe totals", () => {
    expect(tableQueryResponseSchema.parse({
      source: {
        kind: "table",
        database: "app",
        schema: "public",
        table: "users",
      },
      columns: [{
        name: "id",
        typeName: "BIGINT",
        nullable: false,
        dataCategory: "number",
      }],
      rows: [["9007199254740992"]],
      page: 1,
      pageSize: 50,
      totalRows: "9007199254740992",
      totalPages: "180143985094820",
      hasNextPage: true,
    })).toBeTruthy();
  });

  test("models key_value.scan as bounded cursor iteration without placeholder metadata", () => {
    expect(keyValueScanRequestSchema.parse({
      profileId: "redis-profile",
      dbIndex: 2,
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 2,
      pattern: "*",
      cursor: "0",
      count: 100,
    });
    expect(keyValueScanRequestSchema.safeParse({
      profileId: "redis-profile",
      dbIndex: 2,
      cursor: 9007199254740992,
    }).success).toBe(false);
    expect(keyValueScanRequestSchema.safeParse({
      profileId: "redis-profile",
      dbIndex: 256,
    }).success).toBe(false);
    expect(keyValueScanRequestSchema.safeParse({
      profileId: "redis-profile",
      dbIndex: 2,
      count: 501,
    }).success).toBe(false);
    expect(keyValueScanResponseSchema.parse({
      dbIndex: 2,
      pattern: "user:*",
      nextCursor: "9007199254740993",
      done: false,
      keys: ["user:1", "user:2"],
    })).toEqual({
      dbIndex: 2,
      pattern: "user:*",
      nextCursor: "9007199254740993",
      done: false,
      keys: ["user:1", "user:2"],
    });
    expect(keyValueScanResponseSchema.safeParse({
      dbIndex: 2,
      pattern: "*",
      nextCursor: "0",
      done: true,
      keys: [{ key: "user:1", valueType: "key", ttl: -1 }],
    }).success).toBe(false);
  });

  test("accepts typed key_value.get results without Redis command input", () => {
    expect(keyValueGetRequestSchema.parse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "session:1",
    })).toEqual({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "session:1",
    });
    expect(keyValueGetRequestSchema.safeParse({
      profileId: "redis-profile",
      dbIndex: 0,
      key: "session:1",
      command: "DEL session:1",
    }).success).toBe(false);
    expect(keyValueGetResponseSchema.parse({
      key: "session:1",
      valueType: "hash",
      ttl: 300,
      size: "9007199254740993",
      value: {
        kind: "hash",
        value: [{ field: "userId", value: "42" }],
      },
    })).toBeTruthy();
    expect(keyValueGetResponseSchema.parse({
      key: "binary",
      valueType: "string",
      ttl: -1,
      size: 2048,
      value: {
        kind: "string",
        value: {
          encoding: "binary",
          byteLength: 2048,
          previewHex: "00ff",
        },
      },
    })).toBeTruthy();
  });
});
