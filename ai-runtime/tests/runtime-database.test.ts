import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app";
import { createRuntimeLogger } from "../src/core/logger";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { checksumRuntimeMigration } from "../src/storage/runtime-migration-manager";
import { RUNTIME_MIGRATIONS } from "../src/storage/runtime-migrations";

describe("runtime database", () => {
  test("creates runtime tables and indexes", () => {
    const db = openRuntimeDatabase(":memory:");

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain("runtime_conversations");
    expect(tables).toContain("runtime_runs");
    expect(tables).toContain("runtime_messages");
    expect(tables).toContain("runtime_message_parts");
    expect(tables).toContain("runtime_tool_calls");
    expect(tables).toContain("runtime_permissions");
    expect(tables).toContain("runtime_events");
    expect(tables).toContain("runtime_traces");

    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(indexes).toContain("idx_runtime_runs_conversation");
    expect(indexes).toContain("idx_runtime_messages_conversation");
    expect(indexes).toContain("idx_runtime_parts_message");
    expect(indexes).toContain("idx_runtime_tool_calls_run");
    expect(indexes).toContain("idx_runtime_permissions_run");
    expect(indexes).toContain("idx_runtime_permissions_pending_run");
    expect(indexes).toContain("idx_runtime_permissions_tool_call");
    expect(indexes).toContain("idx_runtime_events_conversation_time");
    expect(indexes).toContain("idx_runtime_traces_run_time");

    const migrations = db
      .query<{ id: string }, []>(
        "SELECT id FROM runtime_schema_migrations ORDER BY id",
      )
      .all()
      .map((row) => row.id);

    expect(tables).toContain("runtime_schema_migrations");
    expect(migrations).toEqual([
      "0001_init_runtime_schema",
      "0002_runtime_agent_mode_policy",
      "0003_runtime_interrupted_status",
      "0004_runtime_run_tool_snapshot",
      "0005_runtime_tool_permission_state",
      "0006_runtime_tool_permission_confirmation",
    ]);

    const runColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(runtime_runs)")
      .all()
      .map((row) => row.name);
    const messageColumns = db
      .query<{ name: string }, []>("PRAGMA table_info(runtime_messages)")
      .all()
      .map((row) => row.name);

    expect(runColumns).toContain("agent_mode");
    expect(runColumns).not.toContain("mode");
    expect(runColumns).not.toContain("profile_id");
    expect(messageColumns).toContain("agent_mode");
    expect(messageColumns).not.toContain("agent");
    expect(messageColumns).not.toContain("mode");
    expect(messageColumns).not.toContain("system");
    expect(messageColumns).not.toContain("tools_json");

    db.close();
  });

  test("createApp initializes runtime sqlite database when runtimeDbPath is configured", async () => {
    const dataDir = join(import.meta.dir, ".tmp-runtime-db");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });

    const runtimeDbPath = join(dataDir, "ai-runtime.sqlite3");
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let appStarted = false;
    const logs: Array<Record<string, unknown>> = [];
    const logger = createRuntimeLogger({
      format: "json",
      write(line: string): void {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      },
    });

    try {
      app = await createApp(
        {
          host: "127.0.0.1",
          port: 8787,
          dataDir,
          catalogPath: join(dataDir, "catalog.json"),
          providersPath: join(dataDir, "providers.json"),
          runtimeDbPath,
        },
        {
          fetchCatalog: async () => null,
          logger,
        },
      );

      expect(existsSync(runtimeDbPath)).toBe(true);

      app.listen({ hostname: "127.0.0.1", port: 0 });
      appStarted = true;

      expect(logs).toContainEqual(
        expect.objectContaining({
          migrationId: "0001_init_runtime_schema",
          msg: "runtime migration applied",
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          migrationId: "0002_runtime_agent_mode_policy",
          msg: "runtime migration applied",
        }),
      );

      const db = new Database(runtimeDbPath);
      try {
        const row = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_conversations'",
          )
          .get();

        expect(row?.name).toBe("runtime_conversations");

        const migration = db
          .query<{ id: string }, []>(
            "SELECT id FROM runtime_schema_migrations WHERE id = '0002_runtime_agent_mode_policy'",
          )
          .get();

        expect(migration?.id).toBe("0002_runtime_agent_mode_policy");
      } finally {
        db.close();
      }

      await app.stop();
      appStarted = false;
      app = undefined;
    } finally {
      if (app && appStarted) {
        await app.stop();
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("reopens an existing runtime database without reapplying migrations", () => {
    const dataDir = join(import.meta.dir, ".tmp-runtime-db-idempotent");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });

    const runtimeDbPath = join(dataDir, "ai-runtime.sqlite3");

    try {
      const firstDb = openRuntimeDatabase(runtimeDbPath);
      firstDb.close();

      const secondDb = openRuntimeDatabase(runtimeDbPath);
      try {
        const records = secondDb
          .query<{ id: string }, []>(
            "SELECT id FROM runtime_schema_migrations ORDER BY id",
          )
          .all()
          .map((row) => row.id);

        expect(records).toEqual([
          "0001_init_runtime_schema",
          "0002_runtime_agent_mode_policy",
          "0003_runtime_interrupted_status",
          "0004_runtime_run_tool_snapshot",
          "0005_runtime_tool_permission_state",
          "0006_runtime_tool_permission_confirmation",
        ]);
      } finally {
        secondDb.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("migrates an existing 0001 database to agent mode columns", () => {
    const dataDir = join(import.meta.dir, ".tmp-runtime-db-agent-mode-migration");
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });

    const runtimeDbPath = join(dataDir, "ai-runtime.sqlite3");

    try {
      const initMigration = RUNTIME_MIGRATIONS[0];
      const oldDb = new Database(runtimeDbPath);
      try {
        oldDb.exec(`
          PRAGMA foreign_keys = ON;
          CREATE TABLE runtime_schema_migrations (
            id TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL
          );
        `);
        oldDb.exec(initMigration.sql);
        oldDb
          .query(
            `INSERT INTO runtime_schema_migrations (id, description, checksum, applied_at)
            VALUES (?, ?, ?, ?)`,
          )
          .run(
            initMigration.id,
            initMigration.description,
            checksumRuntimeMigration(initMigration),
            1,
          );
        oldDb
          .query(
            `INSERT INTO runtime_conversations (
              id, title, version, status_json, time_json
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "conv_old",
            "Old",
            "1",
            JSON.stringify({ type: "idle" }),
            JSON.stringify({ created: 1, updated: 1 }),
          );
        oldDb
          .query(
            `INSERT INTO runtime_runs (
              id, conversation_id, mode, profile_id, provider_id, model_id, status,
              input_json, time_json, limits_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "run_old",
            "conv_old",
            "agent",
            "legacy-profile",
            "openai",
            "gpt-4o",
            "queued",
            JSON.stringify({ messageIds: ["msg_old"], system: "legacy", tools: { old: true } }),
            JSON.stringify({ created: 2 }),
            JSON.stringify({ maxSteps: 4, maxToolCalls: 8 }),
          );
        oldDb
          .query(
            `INSERT INTO runtime_messages (
              id, conversation_id, role, agent, provider_id, model_id, time_json, message_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "msg_old",
            "conv_old",
            "user",
            "legacy-profile",
            "openai",
            "gpt-4o",
            JSON.stringify({ created: 3, completed: 3 }),
            JSON.stringify({
              id: "msg_old",
              conversationId: "conv_old",
              role: "user",
              agent: "legacy-profile",
              system: "legacy",
              tools: { old: true },
              parts: [],
              time: { created: 3, completed: 3 },
            }),
          );
      } finally {
        oldDb.close();
      }

      const migrated = openRuntimeDatabase(runtimeDbPath);
      try {
        const runColumns = migrated
          .query<{ name: string }, []>("PRAGMA table_info(runtime_runs)")
          .all()
          .map((row) => row.name);
        const messageColumns = migrated
          .query<{ name: string }, []>("PRAGMA table_info(runtime_messages)")
          .all()
          .map((row) => row.name);
        const run = migrated
          .query<{ agent_mode: string; input_json: string }, []>(
            "SELECT agent_mode, input_json FROM runtime_runs WHERE id = 'run_old'",
          )
          .get();
        const message = migrated
          .query<{ agent_mode: string | null; message_json: string }, []>(
            "SELECT agent_mode, message_json FROM runtime_messages WHERE id = 'msg_old'",
          )
          .get();

        expect(runColumns).toContain("agent_mode");
        expect(runColumns).not.toContain("mode");
        expect(runColumns).not.toContain("profile_id");
        expect(messageColumns).toContain("agent_mode");
        expect(messageColumns).not.toContain("agent");
        expect(messageColumns).not.toContain("mode");
        expect(messageColumns).not.toContain("system");
        expect(messageColumns).not.toContain("tools_json");
        expect(run?.agent_mode).toBe("agent");
        expect(JSON.parse(run?.input_json ?? "{}")).toMatchObject({
          messageIds: ["msg_old"],
          prompt: { version: "legacy-migration" },
          tools: {
            snapshotId: "tool_snapshot_migrated_run_old",
            runId: "run_old",
            agentMode: "agent",
            activeTools: [],
          },
        });
        expect(message?.agent_mode).toBeNull();
        expect(JSON.parse(message?.message_json ?? "{}")).toMatchObject({
          role: "user",
          agentMode: "ask",
        });
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
