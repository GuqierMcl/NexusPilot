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
  test("backfills the initial fencing token for an existing preparation claim", () => {
    const db = createMemoryDb();
    runRuntimeMigrations(db, RUNTIME_MIGRATIONS.slice(0, 11));
    db.query(
      `INSERT INTO runtime_conversations (
        id, title, version, status_json, time_json
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "conv_fencing_migration",
      "Fencing migration",
      "1",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 1 }),
    );
    db.query(
      `INSERT INTO runtime_runs (
        id, conversation_id, agent_mode, provider_id, model_id, status,
        input_json, time_json, limits_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_fencing_migration",
      "conv_fencing_migration",
      "ask",
      "openai",
      "gpt-4o",
      "running",
      JSON.stringify({ messageIds: [] }),
      JSON.stringify({ created: 1 }),
      JSON.stringify({ maxSteps: 1, maxToolCalls: 0, maxOutputTokens: 128 }),
    );
    db.query(
      `INSERT INTO runtime_context_preparation_claims (
        run_id, request_index, request_hash, owner_id, claimed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "run_fencing_migration",
      0,
      `sha256:${"a".repeat(64)}`,
      "owner_before_fencing",
      100,
      200,
    );

    runRuntimeMigrations(db, RUNTIME_MIGRATIONS);

    expect(db.query<{ fencing_token: number }, []>(
      `SELECT fencing_token FROM runtime_context_preparation_claims
       WHERE run_id = 'run_fencing_migration' AND request_index = 0`,
    ).get()).toEqual({ fencing_token: 1 });
    db.close();
  });

  test("backfills deterministic legacy Run lineage and diagnoses incomplete conversations", () => {
    const db = createMemoryDb();
    runRuntimeMigrations(db, RUNTIME_MIGRATIONS.slice(0, 7));

    const insertConversation = db.query(
      `INSERT INTO runtime_conversations (
        id, title, version, status_json, time_json
      ) VALUES (?, ?, '1', ?, ?)`,
    );
    insertConversation.run(
      "conv_valid_dag",
      "Valid legacy history",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 30 }),
    );
    insertConversation.run(
      "conv_invalid_dag",
      "Incomplete legacy history",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 40 }),
    );
    insertConversation.run(
      "conv_malformed_run_time",
      "Malformed Run time",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 50 }),
    );
    insertConversation.run(
      "conv_non_numeric_run_time",
      "Non-numeric Run time",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 60 }),
    );
    insertConversation.run(
      "conv_missing_run_time",
      "Missing Run time",
      JSON.stringify({ type: "idle" }),
      JSON.stringify({ created: 1, updated: 70 }),
    );

    const insertMessage = db.query(
      `INSERT INTO runtime_messages (
        id, conversation_id, role, agent_mode, run_id, parent_id,
        provider_id, model_id, status_json, time_json, message_json
      ) VALUES (?, ?, ?, 'ask', ?, ?, 'openai', 'gpt-4o', ?, ?, ?)`,
    );
    const saveLegacyRunPair = (input: {
      conversationId: string;
      runId: string;
      userMessageId: string;
      assistantMessageId: string;
      created: number;
      persistAssistant?: boolean;
      runTimeJson?: string;
    }): void => {
      const userMessage = {
        id: input.userMessageId,
        conversationId: input.conversationId,
        role: "user",
        agentMode: "ask",
        parts: [],
        time: { created: input.created },
      };
      insertMessage.run(
        input.userMessageId,
        input.conversationId,
        "user",
        null,
        null,
        JSON.stringify({ type: "complete" }),
        JSON.stringify(userMessage.time),
        JSON.stringify(userMessage),
      );

      if (input.persistAssistant !== false) {
        const assistantMessage = {
          id: input.assistantMessageId,
          conversationId: input.conversationId,
          role: "assistant",
          runId: input.runId,
          parentId: input.userMessageId,
          providerId: "openai",
          modelId: "gpt-4o",
          agentMode: "ask",
          status: { type: "complete" },
          parts: [],
          time: { created: input.created + 1 },
        };
        insertMessage.run(
          input.assistantMessageId,
          input.conversationId,
          "assistant",
          input.runId,
          input.userMessageId,
          JSON.stringify(assistantMessage.status),
          JSON.stringify(assistantMessage.time),
          JSON.stringify(assistantMessage),
        );
      }

      db.query(
        `INSERT INTO runtime_runs (
          id, conversation_id, parent_message_id, assistant_message_id, agent_mode,
          provider_id, model_id, status, input_json, time_json, limits_json
        ) VALUES (?, ?, ?, ?, 'ask', 'openai', 'gpt-4o', 'completed', ?, ?, ?)`,
      ).run(
        input.runId,
        input.conversationId,
        input.userMessageId,
        input.assistantMessageId,
        JSON.stringify({ messageIds: [input.userMessageId] }),
        input.runTimeJson ?? JSON.stringify({ created: input.created }),
        JSON.stringify({ maxSteps: 1, maxToolCalls: 0 }),
      );
    };

    // Equal timestamps deliberately prove the Run ID tie-break is deterministic.
    saveLegacyRunPair({
      conversationId: "conv_valid_dag",
      runId: "run_b",
      userMessageId: "msg_user_b",
      assistantMessageId: "msg_assistant_b",
      created: 10,
    });
    saveLegacyRunPair({
      conversationId: "conv_valid_dag",
      runId: "run_a",
      userMessageId: "msg_user_a",
      assistantMessageId: "msg_assistant_a",
      created: 10,
    });
    saveLegacyRunPair({
      conversationId: "conv_invalid_dag",
      runId: "run_incomplete",
      userMessageId: "msg_user_incomplete",
      assistantMessageId: "msg_assistant_missing",
      created: 20,
      persistAssistant: false,
    });
    saveLegacyRunPair({
      conversationId: "conv_malformed_run_time",
      runId: "run_malformed_time",
      userMessageId: "msg_user_malformed_time",
      assistantMessageId: "msg_assistant_malformed_time",
      created: 30,
      runTimeJson: "{",
    });
    saveLegacyRunPair({
      conversationId: "conv_non_numeric_run_time",
      runId: "run_non_numeric_time",
      userMessageId: "msg_user_non_numeric_time",
      assistantMessageId: "msg_assistant_non_numeric_time",
      created: 40,
      runTimeJson: JSON.stringify({ created: "forty" }),
    });
    saveLegacyRunPair({
      conversationId: "conv_missing_run_time",
      runId: "run_missing_time",
      userMessageId: "msg_user_missing_time",
      assistantMessageId: "msg_assistant_missing_time",
      created: 50,
      runTimeJson: JSON.stringify({}),
    });

    expect(RUNTIME_MIGRATIONS.at(-1)?.id).toBe(
      "0013_runtime_context_diagnostics",
    );
    expect(() => runRuntimeMigrations(db, RUNTIME_MIGRATIONS)).not.toThrow();

    const validConversation = db
      .query<{ active_head_run_id: string | null; revision: number }, []>(
        `SELECT active_head_run_id, revision
         FROM runtime_conversations WHERE id = 'conv_valid_dag'`,
      )
      .get();
    const validRuns = db
      .query<
        { id: string; parent_run_id: string | null; supersedes_run_id: string | null },
        []
      >(
        `SELECT id, parent_run_id, supersedes_run_id
         FROM runtime_runs WHERE conversation_id = 'conv_valid_dag'
         ORDER BY id`,
      )
      .all();
    const invalidConversation = db
      .query<{ active_head_run_id: string | null; revision: number }, []>(
        `SELECT active_head_run_id, revision
         FROM runtime_conversations WHERE id = 'conv_invalid_dag'`,
      )
      .get();
    const diagnostics = db
      .query<{ conversation_id: string; code: string; details_json: string }, []>(
        `SELECT conversation_id, code, details_json
         FROM runtime_history_diagnostics ORDER BY conversation_id`,
      )
      .all();

    expect(validRuns).toEqual([
      { id: "run_a", parent_run_id: null, supersedes_run_id: null },
      { id: "run_b", parent_run_id: "run_a", supersedes_run_id: null },
    ]);
    expect(validConversation).toEqual({ active_head_run_id: "run_b", revision: 2 });
    expect(invalidConversation).toEqual({ active_head_run_id: null, revision: 0 });
    expect(
      db.query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM runtime_runs WHERE conversation_id = 'conv_invalid_dag'`,
      ).get()?.count,
    ).toBe(1);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.map((diagnostic) => diagnostic.conversation_id)).toEqual([
      "conv_invalid_dag",
      "conv_malformed_run_time",
      "conv_missing_run_time",
      "conv_non_numeric_run_time",
    ]);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe("LEGACY_DAG_BACKFILL_INVALID");
      expect(JSON.parse(diagnostic.details_json)).toMatchObject({ runCount: 1 });
      const invalid = db
        .query<{ active_head_run_id: string | null; revision: number }, [string]>(
          `SELECT active_head_run_id, revision
           FROM runtime_conversations WHERE id = ?`,
        )
        .get(diagnostic.conversation_id);
      expect(invalid).toEqual({ active_head_run_id: null, revision: 0 });
    }

    db.close();
  });

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
