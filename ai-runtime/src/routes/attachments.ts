import { Elysia } from "elysia";
import { isRuntimeId } from "../runtime/core/ids";
import type { AttachmentId, UploadId } from "../runtime/core/types";
import {
  attachmentErrorEnvelope,
  RuntimeAttachmentError,
  type RuntimeAttachment,
  type RuntimeAttachmentService,
  type RuntimeAttachmentUpload,
} from "../runtime/attachments";

export interface AttachmentRouteDeps {
  attachmentService: RuntimeAttachmentService | null;
}

export function attachmentRoutes(deps: AttachmentRouteDeps) {
  return new Elysia({ name: "routes.attachments" })
    .post("/v1/attachment-uploads", async ({ request }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      try {
        const body = await request.json().catch(() => null);
        if (!isRecord(body) || hasUnknownKeys(body, ["filename", "media_type", "byte_length"])) {
          return invalidRequest("上传元数据格式无效。");
        }
        if (
          typeof body.filename !== "string" ||
          (body.media_type !== undefined && typeof body.media_type !== "string") ||
          typeof body.byte_length !== "number"
        ) {
          return invalidRequest("上传元数据格式无效。");
        }
        const upload = service.createUpload({
          filename: body.filename,
          ...(body.media_type ? { declaredMediaType: body.media_type } : {}),
          declaredByteLength: body.byte_length,
        });
        return Response.json(projectUpload(upload), { status: 201 });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .put("/v1/attachment-uploads/:uploadId/content", async ({ params, request }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.uploadId, "upl")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404),
        );
      }
      try {
        const upload = service.getUpload(params.uploadId as UploadId);
        if (upload.state === "completed" && upload.attachmentId) {
          return Response.json({
            upload_id: params.uploadId,
            state: "completed",
            attachment: projectAttachment(service.getAttachment(upload.attachmentId)),
          });
        }
      } catch (error) {
        return attachmentErrorResponse(error);
      }
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
        return invalidRequest("上传内容必须使用 application/octet-stream。", 415);
      }
      const contentLength = parseContentLength(request.headers.get("content-length"));
      try {
        const attachment = await service.upload(
          params.uploadId as UploadId,
          request.body,
          contentLength,
          request.signal,
        );
        return Response.json({
          upload_id: params.uploadId,
          state: "completed",
          attachment: projectAttachment(attachment),
        });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .get("/v1/attachment-uploads/:uploadId", ({ params }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.uploadId, "upl")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404),
        );
      }
      try {
        return projectUpload(service.getUpload(params.uploadId as UploadId), service);
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .delete("/v1/attachment-uploads/:uploadId", async ({ params }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.uploadId, "upl")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404),
        );
      }
      try {
        await service.deleteUpload(params.uploadId as UploadId);
        return new Response(null, { status: 204 });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .get("/v1/attachments/:attachmentId", ({ params }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.attachmentId, "att")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404),
        );
      }
      try {
        return projectAttachment(service.getAttachment(params.attachmentId as AttachmentId));
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .get("/v1/attachments/:attachmentId/content", async ({ params }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.attachmentId, "att")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404),
        );
      }
      try {
        const { attachment, blob, path } = await service.getContent(
          params.attachmentId as AttachmentId,
        );
        return new Response(Bun.file(path), {
          headers: {
            "Content-Type": attachment.mediaType,
            "Content-Length": String(attachment.byteLength),
            "Content-Disposition": contentDisposition(attachment),
            ETag: `"sha256-${blob.sha256}"`,
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
          },
        });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    })
    .delete("/v1/attachments/:attachmentId", async ({ params }) => {
      const service = requireService(deps);
      if (service instanceof Response) return service;
      if (!isRuntimeId(params.attachmentId, "att")) {
        return attachmentErrorResponse(
          new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404),
        );
      }
      try {
        await service.deleteAttachment(params.attachmentId as AttachmentId);
        return new Response(null, { status: 204 });
      } catch (error) {
        return attachmentErrorResponse(error);
      }
    });
}

function requireService(deps: AttachmentRouteDeps): RuntimeAttachmentService | Response {
  return deps.attachmentService ?? Response.json(
    { code: "ATTACHMENT_CONTENT_MISSING", message: "附件存储不可用。" },
    { status: 503 },
  );
}

function projectUpload(
  upload: RuntimeAttachmentUpload,
  service?: RuntimeAttachmentService,
): Record<string, unknown> {
  return {
    upload_id: upload.id,
    state: upload.state,
    expires_at: upload.expiresAt,
    ...(upload.state === "completed" && upload.attachmentId && service
      ? { attachment: projectAttachment(service.getAttachment(upload.attachmentId)) }
      : {}),
  };
}

function projectAttachment(attachment: RuntimeAttachment): Record<string, unknown> {
  return {
    id: attachment.id,
    filename: attachment.filename,
    media_type: attachment.mediaType,
    byte_length: attachment.byteLength,
    state: attachment.state,
  };
}

function attachmentErrorResponse(error: unknown): Response {
  if (error instanceof RuntimeAttachmentError) {
    return Response.json(attachmentErrorEnvelope(error), { status: error.status });
  }
  return Response.json(
    { code: "ATTACHMENT_CORRUPT", message: "附件操作失败。" },
    { status: 500 },
  );
}

function invalidRequest(message: string, status = 422): Response {
  return Response.json(
    { code: "ATTACHMENT_CORRUPT", message },
    { status },
  );
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function contentDisposition(attachment: RuntimeAttachment): string {
  const inline = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
    attachment.mediaType,
  );
  const encoded = encodeURIComponent(attachment.filename).replaceAll("'", "%27");
  return `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`;
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
