import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createRuntimeLogger } from "../src/core/logger";
import {
  ATTACHMENT_LIMITS,
  RuntimeAttachmentService,
  RuntimeAttachmentSqliteStore,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";
import { APP_VERSION } from "../src/version";

describe("health route", () => {
  test("returns BaseResponse health payload", async () => {
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir: "",
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    });

    const response = await app.handle(new Request("http://localhost/health"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      code: "success",
      message: "Success",
      data: {
        status: "unhealthy",
        version: APP_VERSION,
        backendBridge: { state: "waiting" },
        attachments: { status: "unavailable", warnings: [] },
        context: { status: "unavailable", warnings: [] },
      },
    });
  });

  test("logs completed requests when a logger is provided", async () => {
    const lines: string[] = [];
    const logger = createRuntimeLogger({
      format: "pretty",
      level: "info",
      write: (line) => lines.push(line),
    });
    const app = await createApp(
      {
        host: "127.0.0.1",
        port: 8787,
        dataDir: "",
        catalogPath: "",
        providersPath: "",
        runtimeDbPath: "",
      },
      { logger },
    );

    await app.handle(new Request("http://localhost/health"));

    const output = lines.join("");
    expect(output).toContain("request completed");
    expect(output).toContain("method=GET");
    expect(output).toContain("path=/health");
    expect(output).toContain("status=503");
  });

  test("keeps safe checkpoint integrity warnings healthy without leaking diagnostic details", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-context-health-"));
    const db = openRuntimeDatabase(":memory:");
    db.query(
      `INSERT INTO runtime_context_diagnostics (
        id, code, conversation_id, checkpoint_id, run_id, reason, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ctxdiag_health_future",
      "CHECKPOINT_STARTUP_WARNING",
      "conv_health",
      "ckpt_health_future",
      null,
      "unsupported_format",
      JSON.stringify({ summary: "HEALTH_SUMMARY_MUST_NOT_LEAK", formatVersion: "future-9" }),
      1,
    );
    const attachmentService = new RuntimeAttachmentService(
      new RuntimeAttachmentSqliteStore(db),
      dataDir,
    );
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir,
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    }, { runtimeDatabase: db, attachmentService });
    try {
      const response = await app.handle(new Request("http://localhost/health"));
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(200);
      expect(JSON.parse(serialized)).toMatchObject({
        data: {
          status: "ok",
          context: {
            status: "warning",
            warnings: [{
              code: "CHECKPOINT_STARTUP_WARNING",
              conversationId: "conv_health",
              checkpointId: "ckpt_health_future",
              reason: "unsupported_format",
            }],
          },
        },
      });
      expect(serialized).not.toContain("HEALTH_SUMMARY_MUST_NOT_LEAK");
      expect(serialized).not.toContain("future-9");
    } finally {
      attachmentService.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("reports an unavailable context database as unhealthy", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-context-db-health-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentService = new RuntimeAttachmentService(
      new RuntimeAttachmentSqliteStore(db),
      dataDir,
    );
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir,
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    }, { runtimeDatabase: db, attachmentService });
    try {
      db.close();
      const response = await app.handle(new Request("http://localhost/health"));

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        data: {
          status: "unhealthy",
          attachments: { status: "ok" },
          context: { status: "unavailable", warnings: [] },
        },
      });
    } finally {
      attachmentService.dispose();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps local attachment warnings healthy but reports root failure as unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-health-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentService = new RuntimeAttachmentService(
      new RuntimeAttachmentSqliteStore(db),
      dataDir,
    );
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      dataDir,
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    }, { runtimeDatabase: db, attachmentService });
    try {
      const stalePath = join(attachmentService.rootDir, "tmp", "health-stale.part");
      writeFileSync(stalePath, "stale");
      const staleTime = new Date(Date.now() - ATTACHMENT_LIMITS.tempFileTtlMs - 1_000);
      utimesSync(stalePath, staleTime, staleTime);
      await attachmentService.collectGarbage();

      const warningResponse = await app.handle(new Request("http://localhost/health"));
      expect(warningResponse.status).toBe(200);
      expect(await warningResponse.json()).toMatchObject({
        data: { status: "ok", attachments: { status: "warning" } },
      });

      rmSync(attachmentService.rootDir, { recursive: true, force: true });
      await expect(attachmentService.collectGarbage()).rejects.toBeDefined();
      const unavailableResponse = await app.handle(new Request("http://localhost/health"));
      expect(unavailableResponse.status).toBe(503);
      expect(await unavailableResponse.json()).toMatchObject({
        data: { status: "unhealthy", attachments: { status: "unavailable" } },
      });
    } finally {
      attachmentService.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
