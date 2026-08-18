import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  checksumRuntimeMigration,
  runRuntimeMigrations,
  type RuntimeMigration,
} from "../src/storage/runtime-migration-manager";
import { RUNTIME_MIGRATIONS } from "../src/storage/runtime-migrations";
import { RuntimeSqliteStore } from "../src/runtime";

function createMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("runtime migration manager", () => {
  test("applies migrations and records metadata", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "0001_create_probe",
        description: "Create probe table",
        sql: "CREATE TABLE probe (id TEXT PRIMARY KEY);",
      },
    ];

    runRuntimeMigrations(db, migrations);

    const table = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'",
      )
      .get();
    const record = db
      .query<
        {
          id: string;
          description: string;
          checksum: string;
          applied_at: number;
        },
        []
      >(
        "SELECT id, description, checksum, applied_at FROM runtime_schema_migrations",
      )
      .get();

    expect(table?.name).toBe("probe");
    expect(record?.id).toBe("0001_create_probe");
    expect(record?.description).toBe("Create probe table");
    expect(record?.checksum).toBe(checksumRuntimeMigration(migrations[0]));
    expect(typeof record?.applied_at).toBe("number");

    db.close();
  });

  test("logs each migration after it is applied", () => {
    const db = createMemoryDb();
    const logs: Array<{ payload: Record<string, unknown>; message: string }> = [];
    const migrations: RuntimeMigration[] = [
      {
        id: "0001_create_logged_probe",
        description: "Create logged probe table",
        sql: "CREATE TABLE logged_probe (id TEXT PRIMARY KEY);",
      },
    ];

    runRuntimeMigrations(db, migrations, {
      logger: {
        info(payload: Record<string, unknown>, message: string): void {
          logs.push({ payload, message });
        },
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].message).toBe("runtime migration applied");
    expect(logs[0].payload).toMatchObject({
      migrationId: "0001_create_logged_probe",
      description: "Create logged probe table",
      checksum: checksumRuntimeMigration(migrations[0]),
    });
    expect(typeof logs[0].payload.appliedAt).toBe("number");

    runRuntimeMigrations(db, migrations, {
      logger: {
        info(payload: Record<string, unknown>, message: string): void {
          logs.push({ payload, message });
        },
      },
    });

    expect(logs).toHaveLength(1);

    db.close();
  });

  test("does not reapply already recorded migrations", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "0001_create_counter",
        description: "Create counter table",
        sql: `
          CREATE TABLE counter (id TEXT PRIMARY KEY);
          INSERT INTO counter (id) VALUES ('first');
        `,
      },
    ];

    runRuntimeMigrations(db, migrations);
    runRuntimeMigrations(db, migrations);

    const rows = db
      .query<{ count: number }, []>("SELECT count(*) AS count FROM counter")
      .get();
    const migrationRows = db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM runtime_schema_migrations WHERE id = '0001_create_counter'",
      )
      .get();

    expect(rows?.count).toBe(1);
    expect(migrationRows?.count).toBe(1);

    db.close();
  });

  test("rejects checksum changes for applied migrations", () => {
    const db = createMemoryDb();
    const original: RuntimeMigration = {
      id: "0001_create_checksum_probe",
      description: "Create checksum probe",
      sql: "CREATE TABLE checksum_probe (id TEXT PRIMARY KEY);",
    };
    const changed: RuntimeMigration = {
      id: "0001_create_checksum_probe",
      description: "Create checksum probe",
      sql: "CREATE TABLE checksum_probe (id TEXT PRIMARY KEY, value TEXT);",
    };

    runRuntimeMigrations(db, [original]);

    expect(() => runRuntimeMigrations(db, [changed])).toThrow(
      "Runtime migration checksum mismatch for 0001_create_checksum_probe",
    );

    db.close();
  });

  test("rolls back a failing migration without recording it", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "0001_create_ok_table",
        description: "Create ok table",
        sql: "CREATE TABLE ok_table (id TEXT PRIMARY KEY);",
      },
      {
        id: "0002_fail_after_create",
        description: "Fail after creating transient table",
        sql: `
          CREATE TABLE transient_table (id TEXT PRIMARY KEY);
          INSERT INTO missing_table (id) VALUES ('boom');
        `,
      },
    ];

    expect(() => runRuntimeMigrations(db, migrations)).toThrow();

    const okTable = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok_table'",
      )
      .get();
    const transientTable = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transient_table'",
      )
      .get();
    const records = db
      .query<{ id: string }, []>(
        "SELECT id FROM runtime_schema_migrations ORDER BY id",
      )
      .all()
      .map((row) => row.id);

    expect(okTable?.name).toBe("ok_table");
    expect(transientTable).toBeNull();
    expect(records).toEqual(["0001_create_ok_table"]);

    db.close();
  });

  test("rejects duplicate migration ids", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "0001_duplicate",
        description: "First duplicate",
        sql: "CREATE TABLE duplicate_a (id TEXT PRIMARY KEY);",
      },
      {
        id: "0001_duplicate",
        description: "Second duplicate",
        sql: "CREATE TABLE duplicate_b (id TEXT PRIMARY KEY);",
      },
    ];

    expect(() => runRuntimeMigrations(db, migrations)).toThrow(
      "Duplicate runtime migration id: 0001_duplicate",
    );

    db.close();
  });

  test("rejects unsorted migration ids", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "0002_second",
        description: "Second migration",
        sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY);",
      },
      {
        id: "0001_first",
        description: "First migration",
        sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY);",
      },
    ];

    expect(() => runRuntimeMigrations(db, migrations)).toThrow(
      "Runtime migrations must be sorted by id",
    );

    db.close();
  });

  test("rejects invalid migration ids", () => {
    const db = createMemoryDb();
    const migrations: RuntimeMigration[] = [
      {
        id: "initial_schema",
        description: "Invalid id",
        sql: "CREATE TABLE invalid_id_table (id TEXT PRIMARY KEY);",
      },
    ];

    expect(() => runRuntimeMigrations(db, migrations)).toThrow(
      "Invalid runtime migration id: initial_schema",
    );

    db.close();
  });

  test("migrates legacy Permission rows into pending Tool Permission facts", () => {
    const db = createMemoryDb();
    runRuntimeMigrations(db, RUNTIME_MIGRATIONS.slice(0, 4));

    db.query(
      `INSERT INTO runtime_conversations (
        id, title, version, status_json, time_json
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "conv_legacy_permission",
      "Legacy permission",
      "1",
      JSON.stringify({ type: "busy", runId: "run_legacy_permission" }),
      JSON.stringify({ created: 1, updated: 2 }),
    );
    db.query(
      `INSERT INTO runtime_runs (
        id, conversation_id, agent_mode, provider_id, model_id, status,
        input_json, time_json, limits_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_legacy_permission",
      "conv_legacy_permission",
      "agent",
      "openai",
      "gpt-4o",
      "waiting_for_permission",
      JSON.stringify({ messageIds: ["msg_legacy_permission"] }),
      JSON.stringify({ created: 2, started: 3 }),
      JSON.stringify({ maxSteps: 4, maxToolCalls: 8 }),
    );
    db.query(
      `INSERT INTO runtime_messages (
        id, conversation_id, role, agent_mode, run_id, provider_id, model_id,
        status_json, time_json, message_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg_legacy_permission",
      "conv_legacy_permission",
      "assistant",
      "agent",
      "run_legacy_permission",
      "openai",
      "gpt-4o",
      JSON.stringify({ type: "running" }),
      JSON.stringify({ created: 3 }),
      JSON.stringify({
        id: "msg_legacy_permission",
        conversationId: "conv_legacy_permission",
        role: "assistant",
        runId: "run_legacy_permission",
        providerId: "openai",
        modelId: "gpt-4o",
        agentMode: "agent",
        status: { type: "running" },
        parts: [],
        time: { created: 3 },
      }),
    );
    db.query(
      `INSERT INTO runtime_tool_calls (
        id, conversation_id, run_id, message_id, tool_name, state,
        input_json, permission_id, time_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "tool_legacy_permission",
      "conv_legacy_permission",
      "run_legacy_permission",
      "msg_legacy_permission",
      "legacy.write",
      "waiting_for_permission",
      JSON.stringify({ value: 1 }),
      "perm_legacy_permission",
      JSON.stringify({ created: 4 }),
    );
    db.query(
      `INSERT INTO runtime_permissions (
        id, conversation_id, run_id, message_id, tool_call_id, type, title,
        metadata_json, time_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "perm_legacy_permission",
      "conv_legacy_permission",
      "run_legacy_permission",
      "msg_legacy_permission",
      "tool_legacy_permission",
      "business_write",
      "Legacy write",
      JSON.stringify({
        toolName: "legacy.write",
        sideEffect: "business_write",
        risk: "high",
      }),
      JSON.stringify({ created: 4 }),
    );

    runRuntimeMigrations(db, RUNTIME_MIGRATIONS);

    const store = new RuntimeSqliteStore(db);
    expect(store.getPermission("perm_legacy_permission")).toEqual({
      id: "perm_legacy_permission",
      conversationId: "conv_legacy_permission",
      runId: "run_legacy_permission",
      messageId: "msg_legacy_permission",
      toolCallId: "tool_legacy_permission",
      status: "pending",
      toolId: "legacy.write",
      title: "Legacy write",
      risk: {
        level: "high",
        reversible: false,
        sideEffects: ["business_write"],
      },
      confirmation: { level: "standard" },
      createdAt: 4,
    });

    db.close();
  });

  test("migrates legacy cancelled runtime records to interrupted", () => {
    const db = createMemoryDb();
    runRuntimeMigrations(db, RUNTIME_MIGRATIONS.slice(0, 2));

    db.query(
      `INSERT INTO runtime_conversations (
        id, title, version, status_json, time_json
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "conv_cancelled",
      "Legacy cancelled run",
      "1",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 3 }),
    );

    db.query(
      `INSERT INTO runtime_runs (
        id, conversation_id, agent_mode, provider_id, model_id, status, input_json,
        finish, error_json, time_json, limits_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_cancelled",
      "conv_cancelled",
      "ask",
      "openai",
      "gpt-4o",
      "cancelled",
      JSON.stringify({
        messageIds: ["msg_user"],
        prompt: { version: "legacy", blockIds: [], warnings: [] },
        tools: { enabled: [], active: [], warnings: [] },
      }),
      "cancelled",
      JSON.stringify({ name: "MessageAbortedError", data: { message: "legacy stop" } }),
      JSON.stringify({ created: 1, started: 2, completed: 3 }),
      JSON.stringify({ maxSteps: 1, maxToolCalls: 0 }),
    );

    db.query(
      `INSERT INTO runtime_messages (
        id, conversation_id, role, agent_mode, run_id, parent_id, provider_id, model_id,
        status_json, finish, time_json, message_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "msg_cancelled",
      "conv_cancelled",
      "assistant",
      "ask",
      "run_cancelled",
      "msg_user",
      "openai",
      "gpt-4o",
      JSON.stringify({ type: "incomplete", reason: "cancelled" }),
      "cancelled",
      JSON.stringify({ created: 2, completed: 3 }),
      JSON.stringify({
        id: "msg_cancelled",
        conversationId: "conv_cancelled",
        role: "assistant",
        runId: "run_cancelled",
        parentId: "msg_user",
        providerId: "openai",
        modelId: "gpt-4o",
        agentMode: "ask",
        status: { type: "incomplete", reason: "cancelled" },
        finish: "cancelled",
        parts: [],
        time: { created: 2, completed: 3 },
      }),
    );

    runRuntimeMigrations(db, RUNTIME_MIGRATIONS);

    const store = new RuntimeSqliteStore(db);
    const run = store.getRun("run_cancelled");
    const message = store.getMessage("msg_cancelled");

    expect(run?.status).toBe("interrupted");
    expect(run?.finish).toBe("interrupted");
    expect(run?.metadata?.interrupt).toMatchObject({ reason: "unknown" });
    expect(run?.input.tools).toMatchObject({
      snapshotId: "tool_snapshot_migrated_run_cancelled",
      runId: "run_cancelled",
      agentMode: "ask",
      activeTools: [],
    });
    expect(message?.role).toBe("assistant");
    if (message?.role === "assistant") {
      expect(message.status).toEqual({ type: "incomplete", reason: "interrupted" });
      expect(message.finish).toBe("interrupted");
    }

    db.close();
  });
});
