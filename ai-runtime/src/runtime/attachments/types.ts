import type {
  AttachmentId,
  BlobId,
  MessageId,
  PartId,
  UploadId,
} from "../core/types";

export const ATTACHMENT_LIMITS = Object.freeze({
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxMessageAttachments: 10,
  maxMessageAttachmentBytes: 50 * 1024 * 1024,
  maxRunHistoryAttachmentBytes: 100 * 1024 * 1024,
  maxPendingUploads: 20,
  maxBlobBytes: 2 * 1024 * 1024 * 1024,
  uploadTtlMs: 24 * 60 * 60 * 1000,
  unattachedTtlMs: 24 * 60 * 60 * 1000,
  gcGraceMs: 60 * 60 * 1000,
  tempFileTtlMs: 24 * 60 * 60 * 1000,
  readConcurrency: 2,
});

export interface RuntimeAttachmentUpload {
  id: UploadId;
  filename: string;
  declaredMediaType?: string;
  declaredByteLength: number;
  state: "pending" | "completed";
  attachmentId?: AttachmentId;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface RuntimeBlob {
  id: BlobId;
  sha256: string;
  byteLength: number;
  storageKey: string;
  state: "available" | "deleting" | "corrupt";
  createdAt: number;
  verifiedAt?: number;
}

export interface RuntimeAttachment {
  id: AttachmentId;
  blobId: BlobId;
  filename: string;
  declaredMediaType?: string;
  mediaType: string;
  byteLength: number;
  state: "ready" | "corrupt" | "deleting";
  createdAt: number;
  updatedAt: number;
  gcAfter?: number;
}

export interface RuntimeMessageAttachment {
  partId: PartId;
  messageId: MessageId;
  attachmentId: AttachmentId;
  sortIndex: number;
}

export type AttachmentErrorCode =
  | "UPLOAD_NOT_FOUND"
  | "UPLOAD_EXPIRED"
  | "UPLOAD_IN_PROGRESS"
  | "UPLOAD_INTERRUPTED"
  | "UPLOAD_LIMIT_EXCEEDED"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_TOO_LARGE"
  | "ATTACHMENT_COUNT_EXCEEDED"
  | "ATTACHMENT_TOTAL_SIZE_EXCEEDED"
  | "ATTACHMENT_HISTORY_SIZE_EXCEEDED"
  | "ATTACHMENT_LENGTH_MISMATCH"
  | "ATTACHMENT_MEDIA_TYPE_INVALID"
  | "ATTACHMENT_QUOTA_EXCEEDED"
  | "ATTACHMENT_IN_USE"
  | "ATTACHMENT_CONTENT_MISSING"
  | "ATTACHMENT_CORRUPT";

export class RuntimeAttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
    readonly status: number,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RuntimeAttachmentError";
  }
}

export interface AttachmentErrorEnvelope {
  code: AttachmentErrorCode;
  message: string;
  data?: Record<string, unknown>;
}

export interface RuntimeAttachmentDiagnostics {
  status: "ok" | "warning" | "unavailable";
  warnings: string[];
}

export function attachmentErrorEnvelope(error: RuntimeAttachmentError): AttachmentErrorEnvelope {
  return {
    code: error.code,
    message: error.message,
    ...(error.data ? { data: error.data } : {}),
  };
}
