import { describe, expect, test } from "bun:test";
import type { PendingAttachment } from "@assistant-ui/react";

import {
  getRuntimeAttachmentUploadUiState,
  RuntimeAttachmentAdapter,
} from "./runtime-attachment-adapter";
import { isSafeInlineImageType } from "./runtime-attachment-media";

class FakeUploadXhr {
  static responses: Array<{ status: number; body: unknown }> = [];
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  status = 0;
  responseText = "";
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;

  open(): void {}
  setRequestHeader(): void {}
  abort(): void {
    this.onabort?.();
  }
  send(file: File): void {
    const response = FakeUploadXhr.responses.shift();
    if (!response) throw new Error("Missing fake XHR response");
    queueMicrotask(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: file.size,
        total: file.size,
      } as ProgressEvent);
      this.status = response.status;
      this.responseText = JSON.stringify(response.body);
      this.onload?.();
    });
  }
}

async function reachUploadError(
  adapter: RuntimeAttachmentAdapter,
  file: File,
): Promise<PendingAttachment> {
  const generator = adapter.add({ file });
  const first = await generator.next();
  if (first.done) throw new Error("Attachment adapter did not yield a pending record");
  while (true) {
    const next = await generator.next();
    if (next.done) throw new Error("Attachment upload unexpectedly completed");
    if (next.value.status.type === "incomplete") return first.value;
  }
}

describe("RuntimeAttachmentAdapter", () => {
  test("only treats safe raster media types as inline images", async () => {
    expect(isSafeInlineImageType("image/png")).toBe(true);
    expect(isSafeInlineImageType("IMAGE/JPEG; charset=binary")).toBe(true);
    expect(isSafeInlineImageType("image/gif")).toBe(true);
    expect(isSafeInlineImageType("image/webp")).toBe(true);
    expect(isSafeInlineImageType("image/svg+xml")).toBe(false);
    expect(isSafeInlineImageType("text/html")).toBe(false);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    try {
      const adapter = new RuntimeAttachmentAdapter({
        baseUrl: "http://127.0.0.1:8787",
        accessToken: "token",
      });
      const generator = adapter.add({
        file: new File(["<svg/>"] , "active.svg", { type: "image/svg+xml" }),
      });
      const first = await generator.next();
      if (first.done) throw new Error("Attachment adapter did not yield a pending record");
      expect(first.value.type).toBe("document");
      await adapter.remove(first.value);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("retries a failed upload with a new UploadSession", async () => {
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    const requests: Array<{ method: string; path: string }> = [];
    let createCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      if (method === "POST") {
        createCount += 1;
        return Response.json({
          upload_id: createCount === 1 ? "upl_first" : "upl_second",
          state: "pending",
        }, { status: 201 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    globalThis.XMLHttpRequest = FakeUploadXhr as unknown as typeof XMLHttpRequest;
    FakeUploadXhr.responses = [
      { status: 404, body: { code: "UPLOAD_EXPIRED", message: "上传会话已过期。" } },
      {
        status: 200,
        body: {
          attachment: {
            id: "att_ready",
            filename: "retry.txt",
            media_type: "text/plain",
            byte_length: 5,
            state: "ready",
          },
        },
      },
    ];
    try {
      const adapter = new RuntimeAttachmentAdapter({
        baseUrl: "http://127.0.0.1:8787",
        accessToken: "token",
      });
      const pending = await reachUploadError(
        adapter,
        new File(["retry"], "retry.txt", { type: "text/plain" }),
      );

      expect(getRuntimeAttachmentUploadUiState(pending.id)).toEqual({
        phase: "failed",
        progress: 0,
        message: "上传会话已过期。",
      });
      const completion = adapter.send(pending);
      expect(getRuntimeAttachmentUploadUiState(pending.id)).toEqual({
        phase: "retrying",
        progress: 0,
      });
      const completed = await completion;

      expect(createCount).toBe(2);
      expect(requests.some((request) =>
        request.method === "DELETE" &&
        request.path === "/v1/attachment-uploads/upl_first"
      )).toBe(true);
      expect(completed.content?.[0]).toEqual({
        type: "file",
        filename: "retry.txt",
        mimeType: "text/plain",
        data: "nexuspilot-attachment:att_ready",
      });
      expect(getRuntimeAttachmentUploadUiState(pending.id)).toEqual({
        phase: "ready",
        progress: 1,
      });
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
    }
  });

  test("creates another UploadSession after a retry also fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalXhr = globalThis.XMLHttpRequest;
    const requests: Array<{ method: string; path: string }> = [];
    let createCount = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      if (method === "POST") {
        createCount += 1;
        return Response.json({
          upload_id: `upl_attempt_${createCount}`,
          state: "pending",
        }, { status: 201 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    globalThis.XMLHttpRequest = FakeUploadXhr as unknown as typeof XMLHttpRequest;
    FakeUploadXhr.responses = [
      { status: 404, body: { code: "UPLOAD_EXPIRED", message: "上传会话已过期。" } },
      { status: 503, body: { code: "UPLOAD_UNAVAILABLE", message: "上传服务暂时不可用。" } },
      {
        status: 200,
        body: {
          attachment: {
            id: "att_after_three_attempts",
            filename: "retry-again.txt",
            media_type: "text/plain",
            byte_length: 11,
            state: "ready",
          },
        },
      },
    ];
    try {
      const adapter = new RuntimeAttachmentAdapter({
        baseUrl: "http://127.0.0.1:8787",
        accessToken: "token",
      });
      const pending = await reachUploadError(
        adapter,
        new File(["retry-again"], "retry-again.txt", { type: "text/plain" }),
      );

      let retryError: unknown;
      try {
        await adapter.send(pending);
      } catch (error) {
        retryError = error;
      }
      expect(retryError instanceof Error ? retryError.message : "")
        .toBe("上传服务暂时不可用。");
      const completed = await adapter.send(pending);

      expect(createCount).toBe(3);
      expect(requests.filter((request) => request.method === "DELETE").map((request) => request.path))
        .toEqual([
          "/v1/attachment-uploads/upl_attempt_1",
          "/v1/attachment-uploads/upl_attempt_2",
        ]);
      expect(completed.content?.[0]).toEqual({
        type: "file",
        filename: "retry-again.txt",
        mimeType: "text/plain",
        data: "nexuspilot-attachment:att_after_three_attempts",
      });
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.XMLHttpRequest = originalXhr;
    }
  });

  test("aborts UploadSession creation when a pending attachment is removed", async () => {
    const originalFetch = globalThis.fetch;
    let aborted = false;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })) as typeof fetch;
    try {
      const adapter = new RuntimeAttachmentAdapter({
        baseUrl: "http://127.0.0.1:8787",
        accessToken: "token",
      });
      const generator = adapter.add({ file: new File(["x"], "cancel.txt") });
      const first = await generator.next();
      if (first.done) throw new Error("Attachment adapter did not yield a pending record");
      const inFlight = generator.next();
      await Promise.resolve();

      await adapter.remove(first.value);
      const result = await inFlight;

      expect(aborted).toBe(true);
      expect(result.done).toBe(false);
      expect(result.value?.status.type).toBe("incomplete");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
