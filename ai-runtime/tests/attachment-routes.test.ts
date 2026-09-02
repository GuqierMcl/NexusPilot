import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { RuntimeAttachmentService, RuntimeAttachmentSqliteStore } from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

describe("attachment routes", () => {
  test("requires Bearer auth and round-trips raw content with safe headers", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-route-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentService = new RuntimeAttachmentService(
      new RuntimeAttachmentSqliteStore(db),
      dataDir,
    );
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      accessToken: "attachment-token",
      dataDir,
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    }, { runtimeDatabase: db, attachmentService });
    const auth = { Authorization: "Bearer attachment-token" };
    try {
      const health = await app.handle(new Request("http://localhost/health"));
      expect(await health.json()).toMatchObject({
        data: { status: "ok", attachments: { status: "ok", warnings: [] } },
      });
      const unauthorized = await app.handle(new Request(
        "http://localhost/v1/attachment-uploads",
        { method: "POST" },
      ));
      expect(unauthorized.status).toBe(401);

      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]);
      const created = await app.handle(new Request(
        "http://localhost/v1/attachment-uploads",
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: "report.pdf",
            media_type: "application/octet-stream",
            byte_length: bytes.byteLength,
          }),
        },
      ));
      expect(created.status).toBe(201);
      const upload = await created.json() as { upload_id: string };

      const completed = await app.handle(new Request(
        `http://localhost/v1/attachment-uploads/${upload.upload_id}/content`,
        {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
          },
          body: bytes,
        },
      ));
      expect(completed.status).toBe(200);
      const result = await completed.json() as {
        attachment: { id: string; media_type: string };
      };
      expect(result.attachment.id.startsWith("att_")).toBe(true);
      expect(result.attachment.media_type).toBe("application/pdf");

      const content = await app.handle(new Request(
        `http://localhost/v1/attachments/${result.attachment.id}/content`,
        { headers: auth },
      ));
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toBe("application/pdf");
      expect(content.headers.get("content-disposition")).toStartWith("attachment;");
      expect(content.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Array.from(new Uint8Array(await content.arrayBuffer()))).toEqual(Array.from(bytes));

      const recovered = await app.handle(new Request(
        `http://localhost/v1/attachment-uploads/${upload.upload_id}`,
        { headers: auth },
      ));
      expect(await recovered.json()).toMatchObject({
        upload_id: upload.upload_id,
        state: "completed",
        attachment: { id: result.attachment.id },
      });
    } finally {
      attachmentService.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("returns a structured retryable error when the request is interrupted", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-route-abort-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentService = new RuntimeAttachmentService(
      new RuntimeAttachmentSqliteStore(db),
      dataDir,
    );
    const app = await createApp({
      host: "127.0.0.1",
      port: 8787,
      accessToken: "attachment-token",
      dataDir,
      catalogPath: "",
      providersPath: "",
      runtimeDbPath: "",
    }, { runtimeDatabase: db, attachmentService });
    const auth = { Authorization: "Bearer attachment-token" };
    try {
      const created = await app.handle(new Request(
        "http://localhost/v1/attachment-uploads",
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "abort.bin", byte_length: 2 }),
        },
      ));
      const upload = await created.json() as { upload_id: string };
      const controller = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(new Uint8Array([1]));
        },
      });
      const responsePromise = app.handle(new Request(
        `http://localhost/v1/attachment-uploads/${upload.upload_id}/content`,
        {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": "application/octet-stream",
            "Content-Length": "2",
          },
          body,
          signal: controller.signal,
        },
      ));
      controller.abort("client disconnected");
      const response = await responsePromise;

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "UPLOAD_INTERRUPTED",
        message: "附件上传已中断，可重试。",
      });
      expect(attachmentService.getUpload(upload.upload_id as never).state).toBe("pending");
    } finally {
      attachmentService.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
