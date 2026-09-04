import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  RuntimeAttachmentError,
  ATTACHMENT_LIMITS,
  ContextCompactionService,
  DEFAULT_CONTEXT_COMPACTION_POLICY,
  ModelContextManager,
  RuntimeAttachmentService,
  RuntimeAttachmentSqliteStore,
  RuntimeRunner,
  RuntimeSqliteStore,
  RuntimeTextRunner,
  RuntimeToolRegistry,
  sanitizeFilename,
  type AssistantMessage,
  type Conversation,
  type Event,
  type Message,
  type Run,
  type RuntimeStreamText,
  type RuntimeToolNamespace,
  type TraceEvent,
  type UserMessage,
} from "../src/runtime";
import { openRuntimeDatabase } from "../src/storage/runtime-database";

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("Runtime Attachment Service", () => {
  test("holds the UploadSession lock through final attachment commit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-lock-"));
    const db = openRuntimeDatabase(":memory:");
    let reentrant: Promise<unknown> | null = null;
    let service!: RuntimeAttachmentService;
    class ReentrantStore extends RuntimeAttachmentSqliteStore {
      override completeUpload(
        input: Parameters<RuntimeAttachmentSqliteStore["completeUpload"]>[0],
      ) {
        reentrant = service.upload(
          input.uploadId,
          bytesStream(new Uint8Array([1, 2, 3])),
          3,
        );
        return super.completeUpload(input);
      }
    }
    const store = new ReentrantStore(db);
    service = new RuntimeAttachmentService(store, dataDir);
    try {
      await service.initialize();
      const upload = service.createUpload({ filename: "locked.bin", declaredByteLength: 3 });
      await service.upload(upload.id, bytesStream(new Uint8Array([1, 2, 3])), 3);
      await expect(reentrant!).rejects.toMatchObject({ code: "UPLOAD_IN_PROGRESS" });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("maps an interrupted upload to a stable retryable upload error", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-abort-"));
    const db = openRuntimeDatabase(":memory:");
    const service = new RuntimeAttachmentService(new RuntimeAttachmentSqliteStore(db), dataDir);
    try {
      await service.initialize();
      const upload = service.createUpload({ filename: "abort.bin", declaredByteLength: 1 });
      const controller = new AbortController();
      controller.abort("client disconnected");
      await expect(
        service.upload(upload.id, bytesStream(new Uint8Array([1])), 1, controller.signal),
      ).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED", status: 409 });
      expect(service.getUpload(upload.id).state).toBe("pending");
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("serializes unique Blob quota checks across different hashes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-quota-"));
    const db = openRuntimeDatabase(":memory:");
    class NearQuotaStore extends RuntimeAttachmentSqliteStore {
      override totalStoredBlobBytes(): number {
        return super.totalStoredBlobBytes() + ATTACHMENT_LIMITS.maxBlobBytes - 4;
      }
    }
    const store = new NearQuotaStore(db);
    const service = new RuntimeAttachmentService(store, dataDir);
    try {
      await service.initialize();
      const first = service.createUpload({ filename: "one.bin", declaredByteLength: 4 });
      const second = service.createUpload({ filename: "two.bin", declaredByteLength: 4 });
      const results = await Promise.allSettled([
        service.upload(first.id, bytesStream(new Uint8Array([1, 2, 3, 4])), 4),
        service.upload(second.id, bytesStream(new Uint8Array([4, 3, 2, 1])), 4),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { code: "ATTACHMENT_QUOTA_EXCEEDED" },
      });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("counts corrupt and deleting Blob records against physical quota", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-stored-quota-"));
    const db = openRuntimeDatabase(":memory:");
    class NearQuotaStore extends RuntimeAttachmentSqliteStore {
      override totalStoredBlobBytes(): number {
        return super.totalStoredBlobBytes() + ATTACHMENT_LIMITS.maxBlobBytes - 3;
      }
    }
    const store = new NearQuotaStore(db);
    const service = new RuntimeAttachmentService(store, dataDir);
    try {
      await service.initialize();
      const firstUpload = service.createUpload({ filename: "corrupt.bin", declaredByteLength: 3 });
      const first = await service.upload(
        firstUpload.id,
        bytesStream(new Uint8Array([1, 2, 3])),
        3,
      );
      store.markBlobState(first.blobId, "corrupt");
      expect(store.totalStoredBlobBytes()).toBe(ATTACHMENT_LIMITS.maxBlobBytes);

      const secondUpload = service.createUpload({ filename: "next.bin", declaredByteLength: 1 });
      await expect(
        service.upload(secondUpload.id, bytesStream(new Uint8Array([9])), 1),
      ).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });

      store.markBlobState(first.blobId, "deleting");
      expect(store.totalStoredBlobBytes()).toBe(ATTACHMENT_LIMITS.maxBlobBytes);
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("deletes expired UploadSessions in bounded batches", () => {
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeAttachmentSqliteStore(db);
    try {
      for (let index = 0; index < 55; index += 1) {
        store.createUpload({
          id: `upl_expired_${index}` as never,
          filename: `${index}.bin`,
          declaredByteLength: 0,
          state: "pending",
          createdAt: index,
          updatedAt: index,
          expiresAt: 100,
        });
      }
      store.createUpload({
        id: "upl_current" as never,
        filename: "current.bin",
        declaredByteLength: 0,
        state: "pending",
        createdAt: 200,
        updatedAt: 200,
        expiresAt: 300,
      });

      expect(store.deleteExpiredUploads(200, 50)).toBe(50);
      expect(store.countPendingUploads(0)).toBe(6);
      expect(store.deleteExpiredUploads(200, 50)).toBe(5);
      expect(store.getUpload("upl_current" as never)?.state).toBe("pending");
    } finally {
      db.close();
    }
  });

  test("preserves a UTF-8-safe truncated extension within the filename limit", () => {
    const result = sanitizeFilename(`${"主".repeat(100)}.${"扩".repeat(30)}`);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(255);
    expect(result).toEndWith(`.${"扩".repeat(10)}`);
  });

  test("streams bytes into dataDir and deduplicates physical blobs", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-"));
    const db = openRuntimeDatabase(":memory:");
    const store = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(store, dataDir);
    try {
      await service.initialize();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2]);
      const firstUpload = service.createUpload({
        filename: "C:\\Users\\person\\image.png",
        declaredMediaType: "application/octet-stream",
        declaredByteLength: bytes.byteLength,
      });
      const first = await service.upload(
        firstUpload.id,
        bytesStream(bytes),
        bytes.byteLength,
      );
      const secondUpload = service.createUpload({
        filename: "same-bytes.png",
        declaredByteLength: bytes.byteLength,
      });
      const second = await service.upload(
        secondUpload.id,
        bytesStream(bytes),
        bytes.byteLength,
      );

      expect(first.id).not.toBe(second.id);
      expect(first.blobId).toBe(second.blobId);
      expect(first.filename).toBe("image.png");
      expect(second.filename).toBe("same-bytes.png");
      expect(first.mediaType).toBe("image/png");
      expect(store.totalStoredBlobBytes()).toBe(bytes.byteLength);
      expect(Array.from(await service.readBytes(first.id))).toEqual(Array.from(bytes));
      expect(await service.upload(firstUpload.id, null, null)).toEqual(first);
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("persists message references atomically and protects referenced attachments", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-ref-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    try {
      await service.initialize();
      const bytes = new TextEncoder().encode("attachment body");
      const upload = service.createUpload({
        filename: "notes.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: bytes.byteLength,
      });
      const attachment = await service.upload(upload.id, bytesStream(bytes), bytes.byteLength);
      runtimeStore.saveConversation({
        id: "conv_attachment_ref",
        title: "Attachment",
        version: "1",
        status: { type: "idle" },
        revision: 0,
        time: { created: 1, updated: 1 },
      });
      runtimeStore.saveMessage({
        id: "msg_attachment_ref",
        conversationId: "conv_attachment_ref",
        role: "user",
        agentMode: "ask",
        parts: [{
          id: "part_attachment_ref",
          conversationId: "conv_attachment_ref",
          messageId: "msg_attachment_ref",
          type: "file",
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
          byteLength: attachment.byteLength,
        }],
        time: { created: 2, completed: 2 },
      });

      expect(attachmentStore.countAttachmentReferences(attachment.id)).toBe(1);
      expect(() => attachmentStore.deleteUnreferencedAttachment(attachment.id)).toThrow(
        RuntimeAttachmentError,
      );
      runtimeStore.deleteConversation("conv_attachment_ref");
      expect(attachmentStore.countAttachmentReferences(attachment.id)).toBe(0);
      expect(attachmentStore.getAttachment(attachment.id)?.gcAfter).toBeGreaterThan(Date.now());
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("rolls back a stale Run start before committing facts or attachment references", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-run-cas-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    try {
      await service.initialize();
      const bytes = new TextEncoder().encode("stale attachment");
      const upload = service.createUpload({
        filename: "stale.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: bytes.byteLength,
      });
      const attachment = await service.upload(upload.id, bytesStream(bytes), bytes.byteLength);
      const originalConversation: Conversation = {
        id: "conv_stale_run_start",
        title: "Stale Run",
        version: "1",
        status: { type: "idle" },
        revision: 1,
        time: { created: 1, updated: 1 },
      };
      runtimeStore.saveConversation(originalConversation);

      const userMessage: UserMessage = {
        id: "msg_stale_user",
        conversationId: originalConversation.id,
        role: "user",
        agentMode: "ask",
        parts: [{
          id: "part_stale_file",
          conversationId: originalConversation.id,
          messageId: "msg_stale_user",
          type: "file",
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
          byteLength: attachment.byteLength,
          time: { created: 2 },
        }],
        time: { created: 2, completed: 2 },
      };
      const assistantMessage: AssistantMessage = {
        id: "msg_stale_assistant",
        conversationId: originalConversation.id,
        role: "assistant",
        runId: "run_stale_start",
        parentId: userMessage.id,
        providerId: "openai",
        modelId: "gpt-4o",
        agentMode: "ask",
        status: { type: "running" },
        parts: [],
        time: { created: 2 },
      };
      const run: Run = {
        id: "run_stale_start",
        conversationId: originalConversation.id,
        parentMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        agentMode: "ask",
        providerId: "openai",
        modelId: "gpt-4o",
        status: "running",
        input: { messageIds: [userMessage.id] },
        limits: { maxSteps: 1, maxToolCalls: 0 },
        time: { created: 2, started: 2 },
      };
      const event: Event = {
        id: "evt_stale_start",
        type: "run.updated",
        properties: { info: run },
        time: 2,
      };
      const trace: TraceEvent = {
        id: "trace_stale_start",
        conversationId: originalConversation.id,
        runId: run.id,
        type: "request.received",
        level: "info",
        time: 2,
        payload: {},
      };

      let conflict: unknown;
      try {
        runtimeStore.commitRunStart({
          expectedConversationRevision: 0,
          conversation: {
            ...originalConversation,
            status: { type: "busy", runId: run.id },
            activeHeadRunId: run.id,
            revision: 1,
            time: { ...originalConversation.time, updated: 2 },
          },
          userMessage,
          run,
          assistantMessage,
          events: [event],
          traces: [trace],
        });
      } catch (error) {
        conflict = error;
      }

      expect(runtimeStore.getConversation(originalConversation.id)).toEqual(originalConversation);
      expect(runtimeStore.getRun(run.id)).toBeNull();
      expect(runtimeStore.getMessage(userMessage.id)).toBeNull();
      expect(runtimeStore.getMessage(assistantMessage.id)).toBeNull();
      expect(runtimeStore.listEventsByRun(run.id)).toEqual([]);
      expect(runtimeStore.listTraces(run.id)).toEqual([]);
      expect(attachmentStore.countAttachmentReferences(attachment.id)).toBe(0);
      expect(conflict).toMatchObject({
        name: "RuntimeConversationRevisionConflictError",
        conversationId: originalConversation.id,
        expectedRevision: 0,
        actualRevision: 1,
      });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps attachment references on both branches when editing a message", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-edit-branch-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    let idSequence = 0;
    const runner = new RuntimeRunner({
      store: runtimeStore,
      attachmentService: service,
      now: () => 1_000 + idSequence,
      createId: ((prefix: string) => `${prefix}_${++idSequence}`) as never,
    });
    try {
      await service.initialize();
      const bytes = new TextEncoder().encode("shared branch attachment");
      const upload = service.createUpload({
        filename: "shared.txt",
        declaredMediaType: "text/plain",
        declaredByteLength: bytes.byteLength,
      });
      const attachment = await service.upload(upload.id, bytesStream(bytes), bytes.byteLength);
      const original = runner.start({
        providerId: "openai",
        modelId: "gpt-4o",
        parts: [
          { type: "text", text: "Original question" },
          { type: "file", attachmentId: attachment.id },
        ],
      });
      runner.completeText(original, "Original answer");

      const replacement = runner.start({
        conversationId: original.conversation.id,
        replaceFromMessageId: original.userMessage.id,
        providerId: "openai",
        modelId: "gpt-4o",
        parts: [
          { type: "text", text: "Edited question" },
          { type: "file", attachmentId: attachment.id },
        ],
      });

      expect(runtimeStore.getMessage(original.userMessage.id)).not.toBeNull();
      expect(runtimeStore.listLineageMessages(original.conversation.id, original.run.id).map(
        (message) => message.id,
      )).toEqual([original.userMessage.id, original.assistantMessage.id]);
      expect(runtimeStore.listActiveLineageMessages(original.conversation.id).map(
        (message) => message.id,
      )).toEqual([replacement.userMessage.id, replacement.assistantMessage.id]);
      expect(attachmentStore.countAttachmentReferences(attachment.id)).toBe(2);
      expect(attachmentStore.totalStoredBlobBytes()).toBe(bytes.byteLength);
      expect(db.query<{ gc_after: number | null }, [string]>(
        "SELECT gc_after FROM runtime_attachments WHERE id = ?",
      ).get(attachment.id)).toEqual({ gc_after: null });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("persists corrupt state after a FilePart snapshot mismatch rolls back", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-corrupt-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    try {
      await service.initialize();
      const bytes = new Uint8Array([7, 7]);
      const upload = service.createUpload({ filename: "truth.bin", declaredByteLength: 2 });
      const attachment = await service.upload(upload.id, bytesStream(bytes), 2);
      runtimeStore.saveConversation({
        id: "conv_corrupt_snapshot",
        title: "Integrity",
        version: "1",
        status: { type: "idle" },
        revision: 0,
        time: { created: 1, updated: 1 },
      });
      expect(() => runtimeStore.saveMessage({
        id: "msg_corrupt_snapshot",
        conversationId: "conv_corrupt_snapshot",
        role: "user",
        agentMode: "ask",
        parts: [{
          id: "part_corrupt_snapshot",
          conversationId: "conv_corrupt_snapshot",
          messageId: "msg_corrupt_snapshot",
          type: "file",
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          filename: "tampered.bin",
          byteLength: attachment.byteLength,
        }],
        time: { created: 2, completed: 2 },
      })).toThrow(RuntimeAttachmentError);
      expect(runtimeStore.getMessage("msg_corrupt_snapshot")).toBeNull();
      expect(attachmentStore.getAttachment(attachment.id)?.state).toBe("corrupt");
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("periodic maintenance cleans stale temp files and reports safe diagnostics", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-maintenance-"));
    const db = openRuntimeDatabase(":memory:");
    const service = new RuntimeAttachmentService(new RuntimeAttachmentSqliteStore(db), dataDir);
    try {
      await service.initialize();
      const stalePath = join(service.rootDir, "tmp", "stale.part");
      writeFileSync(stalePath, "stale");
      const staleTime = new Date(Date.now() - ATTACHMENT_LIMITS.tempFileTtlMs - 1_000);
      utimesSync(stalePath, staleTime, staleTime);
      await service.collectGarbage();

      expect(existsSync(stalePath)).toBe(false);
      expect(service.diagnostics()).toMatchObject({
        status: "warning",
        warnings: expect.arrayContaining([
          expect.stringContaining("过期附件临时文件"),
        ]),
      });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("maintenance detects persisted Message/Attachment index mismatches", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-integrity-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    try {
      await service.initialize();
      const upload = service.createUpload({ filename: "indexed.bin", declaredByteLength: 1 });
      const attachment = await service.upload(upload.id, bytesStream(new Uint8Array([1])), 1);
      runtimeStore.saveConversation({
        id: "conv_integrity_scan",
        title: "Integrity scan",
        version: "1",
        status: { type: "idle" },
        revision: 0,
        time: { created: 1, updated: 1 },
      });
      runtimeStore.saveMessage({
        id: "msg_integrity_scan",
        conversationId: "conv_integrity_scan",
        role: "user",
        agentMode: "ask",
        parts: [{
          id: "part_integrity_scan",
          conversationId: "conv_integrity_scan",
          messageId: "msg_integrity_scan",
          type: "file",
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
          byteLength: attachment.byteLength,
        }],
        time: { created: 2, completed: 2 },
      });
      db.query(
        `UPDATE runtime_message_parts
         SET payload_json = json_set(payload_json, '$.filename', 'tampered.bin')
         WHERE id = ?`,
      ).run("part_integrity_scan");

      await service.collectGarbage();

      expect(attachmentStore.getAttachment(attachment.id)?.state).toBe("corrupt");
      expect(service.diagnostics().warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("消息附件引用完整性异常"),
      ]));
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("detects tampering that exists only in runtime_messages.message_json", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-message-json-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    try {
      await service.initialize();
      const upload = service.createUpload({ filename: "truth.bin", declaredByteLength: 1 });
      const attachment = await service.upload(upload.id, bytesStream(new Uint8Array([1])), 1);
      runtimeStore.saveConversation({
        id: "conv_message_json_integrity",
        title: "Message JSON integrity",
        version: "1",
        status: { type: "idle" },
        revision: 0,
        time: { created: 1, updated: 1 },
      });
      runtimeStore.saveMessage({
        id: "msg_message_json_integrity",
        conversationId: "conv_message_json_integrity",
        role: "user",
        agentMode: "ask",
        parts: [{
          id: "part_message_json_integrity",
          conversationId: "conv_message_json_integrity",
          messageId: "msg_message_json_integrity",
          type: "file",
          attachmentId: attachment.id,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
          byteLength: attachment.byteLength,
        }],
        time: { created: 2, completed: 2 },
      });
      db.query(
        `UPDATE runtime_messages
         SET message_json = json_set(message_json, '$.parts[0].filename', 'tampered.bin')
         WHERE id = ?`,
      ).run("msg_message_json_integrity");

      expect(() => runtimeStore.getMessage("msg_message_json_integrity" as never))
        .toThrow(RuntimeAttachmentError);
      expect(attachmentStore.getAttachment(attachment.id)?.state).toBe("corrupt");
      await service.collectGarbage();
      expect(service.diagnostics().warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("消息附件引用完整性异常"),
      ]));
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("projects ordered local bytes to an AI SDK file part for a pure attachment run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-model-"));
    const db = openRuntimeDatabase(":memory:");
    const service = new RuntimeAttachmentService(new RuntimeAttachmentSqliteStore(db), dataDir);
    let captured: Parameters<RuntimeStreamText>[0] | undefined;
    try {
      await service.initialize();
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const upload = service.createUpload({
        filename: "sound.mp3",
        declaredMediaType: "audio/mpeg",
        declaredByteLength: bytes.byteLength,
      });
      const attachment = await service.upload(upload.id, bytesStream(bytes), bytes.byteLength);
      const runner = new RuntimeTextRunner({
        store: new RuntimeSqliteStore(db),
        attachmentService: service,
        resolveLanguageModel: () => ({
          languageModel: new MockLanguageModelV3(),
          runtimeContext: { provider: { providerId: "test", modelId: "multimodal" } },
        }),
        streamText: async (input) => {
          captured = input;
          await input.onFinish?.({ finishReason: "stop" });
          return {
            toUIMessageStreamResponse: () => new Response("data: [DONE]\n\n"),
          };
        },
      });
      const result = await runner.streamText({
        providerId: "test",
        modelId: "multimodal",
        parts: [{ type: "file", attachmentId: attachment.id }],
      });
      await result.response.text();

      expect(result.started.conversation.title).toBe("sound.mp3");
      const content = captured?.messages?.[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      expect(content?.[0]).toMatchObject({
        type: "file",
        mediaType: "audio/mpeg",
        filename: "sound.mp3",
        data: { type: "data" },
      });
      const data = Array.isArray(content) && content[0]?.type === "file"
        && typeof content[0].data === "object" && content[0].data !== null
        && "data" in content[0].data
        ? content[0].data.data
        : null;
      expect(Array.from(data as Uint8Array)).toEqual(Array.from(bytes));
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("returns a safe AI SDK failure stream when content disappears after Run commit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-failure-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const runtimeStore = new RuntimeSqliteStore(db);
    let providerCalled = false;
    try {
      await service.initialize();
      const bytes = new Uint8Array([9, 8, 7]);
      const upload = service.createUpload({
        filename: "missing.bin",
        declaredByteLength: bytes.byteLength,
      });
      const attachment = await service.upload(upload.id, bytesStream(bytes), bytes.byteLength);
      const blob = attachmentStore.getBlob(attachment.blobId)!;
      rmSync(service.resolveStorageKey(blob.storageKey), { force: true });

      const runner = new RuntimeTextRunner({
        store: runtimeStore,
        attachmentService: service,
        resolveLanguageModel: () => ({
          languageModel: new MockLanguageModelV3(),
          runtimeContext: { provider: { providerId: "test", modelId: "multimodal" } },
        }),
        streamText: () => {
          providerCalled = true;
          throw new Error("provider must not receive a missing attachment");
        },
      });
      const result = await runner.streamText({
        providerId: "test",
        modelId: "multimodal",
        parts: [{ type: "file", attachmentId: attachment.id }],
      });
      const streamBody = await result.response.text();

      expect(providerCalled).toBe(false);
      expect(result.response.headers.get("x-nexus-run-id")).toBe(result.started.run.id);
      expect(streamBody).toContain("附件内容不存在");
      expect(runtimeStore.getRun(result.started.run.id)?.status).toBe("failed");
      expect(runtimeStore.getMessage(result.started.userMessage.id)?.parts[0]).toMatchObject({
        type: "file",
        attachmentId: attachment.id,
      });
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("fails a permission continuation safely when a historical attachment disappears", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nexuspilot-attachment-continuation-"));
    const db = openRuntimeDatabase(":memory:");
    const attachmentStore = new RuntimeAttachmentSqliteStore(db);
    const service = new RuntimeAttachmentService(attachmentStore, dataDir);
    const store = new RuntimeSqliteStore(db);
    let modelCalls = 0;
    const namespace: RuntimeToolNamespace = {
      id: "web",
      title: "Test",
      description: "Attachment continuation test",
      tools: [{
        id: "web.fetch",
        title: "Write",
        description: "Approval-gated operation",
        inputSchema: z.object({ value: z.string() }).strict(),
        outputSchema: z.object({ value: z.string() }).strict(),
        executionTarget: "runtime",
        risk: {
          mode: "static",
          level: "critical",
          reversible: true,
          sideEffect: "external_network",
        },
        execute: async () => ({ summary: "done", data: { value: "done" } }),
      }],
      resolveForRun: () => ({ candidateToolIds: ["web.fetch"] }),
    };
    const registry = new RuntimeToolRegistry([namespace]);
    const streamText: RuntimeStreamText = async (input) => {
      modelCalls += 1;
      const toolCall = {
        type: "tool-call" as const,
        toolCallId: "call_attachment_permission",
        toolName: "np__web__fetch",
        input: { value: "x" },
      };
      await input.onChunk?.({ chunk: toolCall });
      const approve = input.toolApproval as unknown as (value: {
        toolCall: typeof toolCall;
        tools: unknown;
        toolsContext: Record<string, never>;
        runtimeContext: undefined;
        messages: [];
      }) => Promise<unknown>;
      await approve({
        toolCall,
        tools: input.tools,
        toolsContext: {},
        runtimeContext: undefined,
        messages: [],
      });
      await input.onChunk?.({
        chunk: {
          type: "tool-approval-request",
          approvalId: "approval_attachment",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        },
      });
      await input.onFinish?.({
        finishReason: "tool-calls",
        stepCount: 1,
        responseMessages: [{
          role: "assistant",
          content: [
            toolCall,
            {
              type: "tool-approval-request",
              approvalId: "approval_attachment",
              toolCallId: toolCall.toolCallId,
            },
          ],
        }],
        totalUsage: {
          inputTokens: 1,
          inputTokenDetails: {
            noCacheTokens: 1,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
          },
          outputTokens: 1,
          outputTokenDetails: { textTokens: 1, reasoningTokens: undefined },
          totalTokens: 2,
        },
      });
      return {
        toUIMessageStreamResponse: () => new Response("data: {}\n\n"),
      };
    };
    try {
      await service.initialize();
      const upload = service.createUpload({ filename: "history.bin", declaredByteLength: 2 });
      const attachment = await service.upload(
        upload.id,
        bytesStream(new Uint8Array([1, 2])),
        2,
      );
      const runner = new RuntimeTextRunner({
        store,
        attachmentService: service,
        toolRegistry: registry,
        getToolApprovalPolicy: () => ({ autoApproveMaxRisk: "low" }),
        resolveLanguageModel: () => ({
          languageModel: new MockLanguageModelV3(),
          runtimeContext: {
            provider: {
              providerId: "test",
              modelId: "multimodal",
              supportsTools: true,
            },
          },
        }),
        streamText,
      });
      const initial = await runner.streamText({
        providerId: "test",
        modelId: "multimodal",
        agentMode: "agent",
        parts: [
          { type: "text", text: "Use the tool" },
          { type: "file", attachmentId: attachment.id },
        ],
      });
      await initial.response.text();
      const permission = store.listPendingPermissionsByRun(initial.started.run.id)[0]!;
      const blob = attachmentStore.getBlob(attachment.blobId)!;
      rmSync(service.resolveStorageKey(blob.storageKey), { force: true });

      const continued = await runner.continueText(initial.started.run.id, [{
        permissionId: permission.id,
        approved: true,
        confirmationText: permission.confirmation.prompt,
      }]);
      const body = await continued.response.text();

      expect(modelCalls).toBe(1);
      expect(body).toContain("附件内容不存在");
      expect(store.getRun(initial.started.run.id)?.status).toBe("failed");
      expect(store.getConversation(initial.started.conversation.id)?.status.type).toBe("error");
      const assistant = store.getMessage(initial.started.assistantMessage.id);
      expect(assistant?.role).toBe("assistant");
      expect(assistant?.role === "assistant" ? assistant.status.type : null).toBe("error");
    } finally {
      service.dispose();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("skips two 40 MiB persisted-style attachment projections behind a checkpoint and reads them on raw rehydrate", async () => {
    const db = openRuntimeDatabase(":memory:");
    class ProjectionStore extends RuntimeSqliteStore {
      projectionMessages: Message[] | null = null;

      override listTranscriptMessages(conversationId: Conversation["id"]): Message[] {
        return this.projectionMessages ?? super.listTranscriptMessages(conversationId);
      }
    }
    const store = new ProjectionStore(db);
    const conversation: Conversation = {
      id: "conv_compacted_attachments",
      title: "Compacted attachments",
      version: "1",
      status: { type: "busy", runId: "run_attachment_d" },
      activeHeadRunId: "run_attachment_d",
      revision: 4,
      time: { created: 1, updated: 40 },
    };
    store.saveConversation(conversation);
    const projectedMessages: Message[] = [];
    const persistPair = (
      suffix: string,
      parentRunId: Run["parentRunId"],
      status: Run["status"],
      created: number,
      filePart?: { attachmentId: `att_${string}`; byteLength: number },
    ): void => {
      const runId = `run_attachment_${suffix}` as Run["id"];
      const userId = `msg_attachment_user_${suffix}` as UserMessage["id"];
      const assistantId = `msg_attachment_assistant_${suffix}` as AssistantMessage["id"];
      const persistedUser: UserMessage = {
        id: userId,
        conversationId: conversation.id,
        role: "user",
        agentMode: "ask",
        parts: [{
          id: `part_attachment_user_${suffix}`,
          conversationId: conversation.id,
          messageId: userId,
          type: "text",
          text: `user ${suffix}`,
        }],
        time: { created },
      };
      const projectedUser: UserMessage = filePart
        ? {
            ...persistedUser,
            parts: [{
              id: `part_attachment_file_${suffix}`,
              conversationId: conversation.id,
              messageId: userId,
              type: "file",
              attachmentId: filePart.attachmentId,
              filename: `${suffix}.bin`,
              mediaType: "application/octet-stream",
              byteLength: filePart.byteLength,
            }],
          }
        : persistedUser;
      const assistant: AssistantMessage = {
        id: assistantId,
        conversationId: conversation.id,
        role: "assistant",
        runId,
        parentId: userId,
        providerId: "openai",
        modelId: "gpt-4o",
        agentMode: "ask",
        status: status === "completed" ? { type: "complete" } : { type: "running" },
        parts: status === "completed" ? [{
          id: `part_attachment_assistant_${suffix}`,
          conversationId: conversation.id,
          messageId: assistantId,
          type: "text",
          text: `assistant ${suffix}`,
        }] : [],
        time: { created: created + 1 },
      };
      const run: Run = {
        id: runId,
        conversationId: conversation.id,
        parentRunId,
        parentMessageId: userId,
        assistantMessageId: assistantId,
        agentMode: "ask",
        providerId: "openai",
        modelId: "gpt-4o",
        status,
        input: { messageIds: [userId] },
        output: { messageId: assistantId, partIds: assistant.parts.map((part) => part.id) },
        limits: { maxSteps: 1, maxToolCalls: 0, maxOutputTokens: 128 },
        time: { created, ...(status === "completed" ? { completed: created + 1 } : {}) },
      };
      store.saveMessage(persistedUser);
      store.saveRun(run);
      store.saveMessage(assistant);
      projectedMessages.push(projectedUser, assistant);
    };
    const fortyMiB = 40 * 1024 * 1024;
    persistPair("a", undefined, "completed", 10, {
      attachmentId: "att_compacted_a",
      byteLength: fortyMiB,
    });
    persistPair("b", "run_attachment_a", "completed", 20, {
      attachmentId: "att_compacted_b",
      byteLength: fortyMiB,
    });
    persistPair("c", "run_attachment_b", "completed", 30);
    persistPair("d", "run_attachment_c", "running", 40);
    store.projectionMessages = projectedMessages;

    let reads = 0;
    const attachmentService = {
      readBytes: async () => {
        reads += 1;
        return new Uint8Array([1]);
      },
    } as unknown as RuntimeAttachmentService;
    const compactionService = new ContextCompactionService({
      store,
      generator: async () => ({ text: "The earlier attachment-backed facts are summarized." }),
    });
    const manager = new ModelContextManager({ store, compactionService, attachmentService });

    const compacted = await manager.prepare({
      conversationId: conversation.id,
      runId: "run_attachment_d",
      requestIndex: 0,
      providerId: "openai",
      modelId: "gpt-4o",
      model: new MockLanguageModelV3(),
      contextWindow: 10_000,
      reservedOutputTokens: 0,
      systemPrompt: "system",
      toolSchemas: {},
      trigger: "auto_pre_turn",
      policy: { ...DEFAULT_CONTEXT_COMPACTION_POLICY, safetyMarginTokens: 0 },
    });
    expect(compacted.plan.view).toBe("checkpoint");
    expect(compacted.plan.rawRunIds).toEqual(["run_attachment_c", "run_attachment_d"]);
    expect(reads).toBe(0);

    const rehydrated = await manager.prepare({
      conversationId: conversation.id,
      runId: "run_attachment_d",
      requestIndex: 1,
      providerId: "openai",
      modelId: "gpt-4o",
      model: new MockLanguageModelV3(),
      contextWindow: 100_000_000,
      reservedOutputTokens: 0,
      systemPrompt: "system",
      toolSchemas: {},
      trigger: "model_switch",
      policy: { ...DEFAULT_CONTEXT_COMPACTION_POLICY, safetyMarginTokens: 0 },
    });
    expect(rehydrated.plan.view).toBe("raw");
    expect(rehydrated.plan.rawRunIds).toEqual([
      "run_attachment_a",
      "run_attachment_b",
      "run_attachment_c",
      "run_attachment_d",
    ]);
    expect(reads).toBe(2);
    db.close();
  });
});
