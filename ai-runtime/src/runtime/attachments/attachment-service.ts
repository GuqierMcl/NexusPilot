import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createRuntimeId } from "../core/ids";
import type { AttachmentId, UploadId } from "../core/types";
import { RuntimeAttachmentSqliteStore } from "./attachment-store";
import {
  ATTACHMENT_LIMITS,
  RuntimeAttachmentError,
  type RuntimeAttachment,
  type RuntimeAttachmentUpload,
  type RuntimeAttachmentDiagnostics,
  type RuntimeBlob,
} from "./types";

export interface CreateUploadInput {
  filename: string;
  declaredMediaType?: string;
  declaredByteLength: number;
}

export interface AttachmentContent {
  attachment: RuntimeAttachment;
  blob: RuntimeBlob;
  path: string;
}

export class RuntimeAttachmentService {
  readonly rootDir: string;
  private readonly blobRoot: string;
  private readonly tempRoot: string;
  private readonly activeUploads = new Map<UploadId, AbortController>();
  private readonly hashLocks = new Map<string, Promise<void>>();
  private quotaLock: Promise<void> = Promise.resolve();
  private readonly maintenanceAbort = new AbortController();
  private maintenanceTask: Promise<void> | null = null;
  private repairCursor: AttachmentId | null = null;
  private integrityCursor: string | null = null;
  private tempCursor: string | null = null;
  private orphanScanStack: Array<{
    directory: string;
    entries: Dirent[];
    index: number;
  }> = [];
  private readonly diagnosticWarnings: string[] = [];
  private fatalError: string | null = null;
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly store: RuntimeAttachmentSqliteStore,
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.rootDir = resolve(dataDir, "attachments");
    this.blobRoot = resolve(this.rootDir, "blobs", "sha256");
    this.tempRoot = resolve(this.rootDir, "tmp");
  }

  async initialize(): Promise<void> {
    try {
      await mkdir(this.blobRoot, { recursive: true, mode: 0o700 });
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      await this.collectGarbage(this.maintenanceAbort.signal);
      this.fatalError = null;
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
    this.gcTimer = setInterval(() => {
      if (this.maintenanceTask) return;
      this.maintenanceTask = this.collectGarbage(this.maintenanceAbort.signal)
        .catch(() => {
          this.markUnavailable();
        })
        .finally(() => {
          this.maintenanceTask = null;
        });
    }, 5 * 60 * 1000);
    this.gcTimer.unref?.();
  }

  dispose(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.maintenanceAbort.abort("runtime stopping");
    for (const controller of this.activeUploads.values()) {
      controller.abort("runtime stopping");
    }
  }

  diagnostics(): RuntimeAttachmentDiagnostics {
    const warnings = [...this.diagnosticWarnings];
    if (this.fatalError) {
      return {
        status: "unavailable",
        warnings: [...warnings, this.fatalError],
      };
    }
    return {
      status: warnings.length > 0 ? "warning" : "ok",
      warnings,
    };
  }

  createUpload(input: CreateUploadInput): RuntimeAttachmentUpload {
    const declaredByteLength = input.declaredByteLength;
    if (!Number.isSafeInteger(declaredByteLength) || declaredByteLength < 0) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_LENGTH_MISMATCH",
        "附件字节数必须是非负安全整数。",
        422,
      );
    }
    if (declaredByteLength > ATTACHMENT_LIMITS.maxAttachmentBytes) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_TOO_LARGE",
        "附件超过 25 MiB 限制。",
        413,
        { limit_bytes: ATTACHMENT_LIMITS.maxAttachmentBytes },
      );
    }
    const declaredMediaType = normalizeDeclaredMediaType(input.declaredMediaType);
    if (input.declaredMediaType && !declaredMediaType) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_MEDIA_TYPE_INVALID",
        "附件媒体类型格式无效。",
        422,
      );
    }
    const createdAt = this.now();
    if (this.store.countPendingUploads(createdAt) >= ATTACHMENT_LIMITS.maxPendingUploads) {
      throw new RuntimeAttachmentError(
        "UPLOAD_LIMIT_EXCEEDED",
        "待上传附件数量已达到 Runtime 上限。",
        429,
        { limit: ATTACHMENT_LIMITS.maxPendingUploads },
      );
    }
    const upload: RuntimeAttachmentUpload = {
      id: createRuntimeId("upl"),
      filename: sanitizeFilename(input.filename),
      ...(declaredMediaType ? { declaredMediaType } : {}),
      declaredByteLength,
      state: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + ATTACHMENT_LIMITS.uploadTtlMs,
    };
    this.store.createUpload(upload);
    return upload;
  }

  getUpload(id: UploadId): RuntimeAttachmentUpload {
    const upload = this.store.getUpload(id);
    if (!upload) {
      throw new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404);
    }
    if (upload.state === "pending" && upload.expiresAt <= this.now()) {
      this.store.deleteUpload(id);
      throw new RuntimeAttachmentError("UPLOAD_EXPIRED", "上传会话已过期。", 404);
    }
    return upload;
  }

  async upload(
    id: UploadId,
    body: ReadableStream<Uint8Array> | null,
    contentLength: number | null,
    requestSignal?: AbortSignal,
  ): Promise<RuntimeAttachment> {
    const upload = this.getUpload(id);
    if (upload.state === "completed" && upload.attachmentId) {
      return this.getAttachment(upload.attachmentId);
    }
    if (!body || contentLength === null || contentLength !== upload.declaredByteLength) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_LENGTH_MISMATCH",
        "Content-Length 与创建上传时声明的字节数不一致。",
        422,
        { declared_bytes: upload.declaredByteLength },
      );
    }
    if (this.activeUploads.has(id)) {
      throw new RuntimeAttachmentError(
        "UPLOAD_IN_PROGRESS",
        "该上传会话已有内容正在写入。",
        409,
      );
    }

    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(requestSignal?.reason);
    requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
    if (requestSignal?.aborted) controller.abort(requestSignal.reason);
    this.activeUploads.set(id, controller);
    const tempPath = join(this.tempRoot, `upload_${id}_${crypto.randomUUID()}.part`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      let byteLength = 0;
      const hash = createHash("sha256");
      let signature = new Uint8Array(0);
      handle = await open(tempPath, "wx", 0o600);
      const reader = body.getReader();
      while (true) {
        if (controller.signal.aborted) {
          await reader.cancel(controller.signal.reason).catch(() => undefined);
          throw new DOMException("Upload aborted", "AbortError");
        }
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        byteLength += value.byteLength;
        if (byteLength > ATTACHMENT_LIMITS.maxAttachmentBytes) {
          throw new RuntimeAttachmentError(
            "ATTACHMENT_TOO_LARGE",
            "附件超过 25 MiB 限制。",
            413,
            { limit_bytes: ATTACHMENT_LIMITS.maxAttachmentBytes },
          );
        }
        if (signature.byteLength < 32) {
          const next = new Uint8Array(Math.min(32, signature.byteLength + value.byteLength));
          next.set(signature);
          next.set(value.subarray(0, next.byteLength - signature.byteLength), signature.byteLength);
          signature = next;
        }
        hash.update(value);
        await handle.write(value);
      }
      if (byteLength !== upload.declaredByteLength) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_LENGTH_MISMATCH",
          "实际附件字节数与声明值不一致。",
          422,
          { declared_bytes: upload.declaredByteLength, actual_bytes: byteLength },
        );
      }
      await handle.sync();
      await handle.close();
      handle = null;

      const sha256 = hash.digest("hex");
      return await this.withHashLock(sha256, async () => {
        return await this.withQuotaLock(async () => {
          const existing = this.store.getBlobBySha256(sha256);
          if (existing && existing.byteLength !== byteLength) {
            throw new RuntimeAttachmentError(
              "ATTACHMENT_CORRUPT",
              "相同内容哈希对应的 Blob 长度不一致。",
              500,
            );
          }
          if (existing && existing.state !== "available") {
            throw new RuntimeAttachmentError(
              "ATTACHMENT_CORRUPT",
              "相同内容对应的 Blob 当前不可用。",
              500,
            );
          }
          if (!existing) {
            const projected = this.store.totalStoredBlobBytes() + byteLength;
            if (projected > ATTACHMENT_LIMITS.maxBlobBytes) {
              throw new RuntimeAttachmentError(
                "ATTACHMENT_QUOTA_EXCEEDED",
                "附件存储空间不足。",
                507,
                { limit_bytes: ATTACHMENT_LIMITS.maxBlobBytes },
              );
            }
          }

          const storageKey = storageKeyForHash(sha256);
          const finalPath = this.resolveStorageKey(storageKey);
          await mkdir(dirname(finalPath), { recursive: true });
          if (existing) {
            await verifyFileLength(finalPath, existing.byteLength);
            await rm(tempPath, { force: true });
          } else {
            try {
              await rename(tempPath, finalPath);
            } catch (error) {
              if (!(await fileExists(finalPath))) throw error;
              await verifyFileLength(finalPath, byteLength);
              await rm(tempPath, { force: true });
            }
          }

          if (controller.signal.aborted) {
            throw new DOMException("Upload aborted", "AbortError");
          }
          const now = this.now();
          const blob: RuntimeBlob = existing ?? {
            id: createRuntimeId("blob"),
            sha256,
            byteLength,
            storageKey,
            state: "available",
            createdAt: now,
            verifiedAt: now,
          };
          const attachment: RuntimeAttachment = {
            id: createRuntimeId("att"),
            blobId: blob.id,
            filename: upload.filename,
            ...(upload.declaredMediaType
              ? { declaredMediaType: upload.declaredMediaType }
              : {}),
            mediaType: detectMediaType(signature, upload.declaredMediaType),
            byteLength,
            state: "ready",
            createdAt: now,
            updatedAt: now,
            gcAfter: now + ATTACHMENT_LIMITS.unattachedTtlMs,
          };
          return this.store.completeUpload({ uploadId: id, attachment, blob, now });
        });
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new RuntimeAttachmentError(
          "UPLOAD_INTERRUPTED",
          "附件上传已中断，可重试。",
          409,
        );
      }
      throw error;
    } finally {
      requestSignal?.removeEventListener("abort", abortFromRequest);
      if (this.activeUploads.get(id) === controller) this.activeUploads.delete(id);
    }
  }

  async deleteUpload(id: UploadId): Promise<void> {
    const active = this.activeUploads.get(id);
    active?.abort("upload deleted");
    if (!this.store.deleteUpload(id)) {
      throw new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404);
    }
  }

  getAttachment(id: AttachmentId): RuntimeAttachment {
    const attachment = this.store.getAttachment(id);
    if (!attachment) {
      throw new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404);
    }
    return attachment;
  }

  resolveMessageAttachments(ids: readonly AttachmentId[]): RuntimeAttachment[] {
    if (ids.length > ATTACHMENT_LIMITS.maxMessageAttachments) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_COUNT_EXCEEDED",
        "单条消息最多可包含 10 个附件。",
        422,
        { limit: ATTACHMENT_LIMITS.maxMessageAttachments },
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_COUNT_EXCEEDED",
        "同一条消息不能重复引用同一个附件。",
        422,
      );
    }

    let totalBytes = 0;
    const attachments = ids.map((id) => {
      const attachment = this.getAttachment(id);
      const blob = this.store.getBlob(attachment.blobId);
      if (attachment.state === "corrupt") {
        throw new RuntimeAttachmentError("ATTACHMENT_CORRUPT", "附件内容已损坏。", 500);
      }
      if (attachment.state !== "ready" || !blob || blob.state !== "available") {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_CONTENT_MISSING",
          "附件内容不存在或暂不可用。",
          422,
        );
      }
      totalBytes += attachment.byteLength;
      return attachment;
    });
    if (totalBytes > ATTACHMENT_LIMITS.maxMessageAttachmentBytes) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_TOTAL_SIZE_EXCEEDED",
        "单条消息的附件总量超过 50 MiB 限制。",
        413,
        { limit_bytes: ATTACHMENT_LIMITS.maxMessageAttachmentBytes },
      );
    }
    return attachments;
  }

  async getContent(id: AttachmentId): Promise<AttachmentContent> {
    const attachment = this.getAttachment(id);
    if (attachment.state === "corrupt") {
      throw new RuntimeAttachmentError("ATTACHMENT_CORRUPT", "附件内容已损坏。", 500);
    }
    if (attachment.state !== "ready") {
      throw new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不可用。", 404);
    }
    const blob = this.store.getBlob(attachment.blobId);
    if (!blob || blob.state !== "available") {
      this.store.markAttachmentCorrupt(id);
      throw new RuntimeAttachmentError("ATTACHMENT_CONTENT_MISSING", "附件内容不存在。", 500);
    }
    const path = this.resolveStorageKey(blob.storageKey);
    try {
      await verifyFileLength(path, attachment.byteLength);
    } catch {
      this.store.markAttachmentCorrupt(id);
      throw new RuntimeAttachmentError("ATTACHMENT_CONTENT_MISSING", "附件内容不存在。", 500);
    }
    return { attachment, blob, path };
  }

  async readBytes(id: AttachmentId): Promise<Uint8Array> {
    const content = await this.getContent(id);
    return new Uint8Array(await Bun.file(content.path).arrayBuffer());
  }

  async deleteAttachment(id: AttachmentId): Promise<void> {
    const existing = this.store.getAttachment(id);
    if (!existing) {
      throw new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404);
    }
    const indexedBlob = this.store.getBlob(existing.blobId);
    if (!indexedBlob) {
      throw new RuntimeAttachmentError("ATTACHMENT_CONTENT_MISSING", "附件内容不存在。", 500);
    }
    await this.withHashLock(indexedBlob.sha256, async () => {
      const blob = this.store.deleteUnreferencedAttachment(id);
      if (blob && !this.store.hasBlobReferences(blob.id)) {
        const path = this.resolveStorageKey(blob.storageKey);
        await rm(path, { force: true });
        this.store.deleteBlobRecord(blob.id);
      }
    });
  }

  async collectGarbage(signal: AbortSignal = this.maintenanceAbort.signal): Promise<void> {
    try {
      if (signal.aborted) return;
      const removedTemporaryFiles = await this.repairTemporaryFiles(signal);
      if (removedTemporaryFiles > 0) {
        this.recordWarning(`已清理 ${removedTemporaryFiles} 个过期附件临时文件。`);
      }
      const expiredUploads = this.store.deleteExpiredUploads(this.now());
      if (expiredUploads > 0) {
        this.recordWarning(`已清理 ${expiredUploads} 个过期附件上传会话。`);
      }
      await this.repairIndexedAttachments(signal);
      await this.repairMessageAttachmentIntegrity(signal);
      if (signal.aborted) return;
      for (const attachment of this.store.listDueAttachments(this.now())) {
        if (signal.aborted) return;
        if (!this.store.markAttachmentDeleting(attachment.id)) continue;
        this.store.deleteDeletingAttachment(attachment.id);
      }
      for (const blob of this.store.listUnreferencedBlobs()) {
        if (signal.aborted) return;
        await this.withHashLock(blob.sha256, async () => {
          if (signal.aborted) return;
          if (this.store.hasBlobReferences(blob.id)) return;
          this.store.markBlobState(blob.id, "deleting");
          const path = this.resolveStorageKey(blob.storageKey);
          try {
            await rm(path, { force: true });
            if (!this.store.hasBlobReferences(blob.id)) {
              this.store.deleteBlobRecord(blob.id);
            }
          } catch {
            // Keep the deleting record so the next bounded GC pass retries safely.
            this.recordWarning("附件 Blob 回收失败，将在下一周期重试。");
          }
        });
      }
      await this.repairOrphanBlobs(signal);
      this.fatalError = null;
    } catch (error) {
      this.markUnavailable();
      throw error;
    }
  }

  resolveStorageKey(storageKey: string): string {
    if (!storageKey || isAbsolute(storageKey)) {
      throw new RuntimeAttachmentError("ATTACHMENT_CORRUPT", "Blob 存储键无效。", 500);
    }
    const path = resolve(this.rootDir, storageKey);
    const child = relative(this.rootDir, path);
    if (!child || child.startsWith("..") || isAbsolute(child)) {
      throw new RuntimeAttachmentError("ATTACHMENT_CORRUPT", "Blob 存储键越界。", 500);
    }
    return path;
  }

  private async withHashLock<T>(hash: string, task: () => Promise<T>): Promise<T> {
    const previous = this.hashLocks.get(hash) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.hashLocks.set(hash, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.hashLocks.get(hash) === queued) this.hashLocks.delete(hash);
    }
  }

  private async withQuotaLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.quotaLock;
    let release!: () => void;
    this.quotaLock = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }

  private async repairTemporaryFiles(signal: AbortSignal, limit = 200): Promise<number> {
    const cutoff = this.now() - ATTACHMENT_LIMITS.tempFileTtlMs;
    const entries = (await readdir(this.tempRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
      .sort((left, right) => left.name.localeCompare(right.name));
    let candidates = this.tempCursor
      ? entries.filter((entry) => entry.name > this.tempCursor!)
      : entries;
    if (candidates.length === 0 && this.tempCursor) {
      this.tempCursor = null;
      candidates = entries;
    }
    const batch = candidates.slice(0, limit);
    let removed = 0;
    for (const entry of batch) {
      if (signal.aborted) break;
      this.tempCursor = entry.name;
      const path = join(this.tempRoot, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs <= cutoff) {
        await rm(path, { force: true }).catch(() => undefined);
        removed += 1;
      }
    }
    if (batch.length < limit) this.tempCursor = null;
    return removed;
  }

  private async repairIndexedAttachments(signal: AbortSignal, limit = 200): Promise<void> {
    const batch = this.store.listAttachmentsForRepair(this.repairCursor, limit);
    let corruptCount = 0;
    for (const attachment of batch) {
      if (signal.aborted) return;
      this.repairCursor = attachment.id;
      if (attachment.state === "deleting") {
        this.store.deleteDeletingAttachment(attachment.id);
        continue;
      }
      const blob = this.store.getBlob(attachment.blobId);
      if (!blob || blob.state !== "available") {
        this.store.markAttachmentCorrupt(attachment.id);
        corruptCount += 1;
        continue;
      }
      try {
        await verifyFileLength(this.resolveStorageKey(blob.storageKey), blob.byteLength);
        this.store.markBlobVerified(blob.id, this.now());
      } catch {
        this.store.markBlobAndAttachmentsCorrupt(blob.id);
        corruptCount += 1;
      }
    }
    if (batch.length < limit) this.repairCursor = null;
    if (corruptCount > 0) {
      this.recordWarning(`检测到并标记 ${corruptCount} 个损坏附件索引。`);
    }
  }

  private async repairMessageAttachmentIntegrity(
    signal: AbortSignal,
    limit = 200,
  ): Promise<void> {
    const issues = this.store.listMessageAttachmentIntegrityIssues(
      this.integrityCursor,
      limit,
    );
    const affected = new Set<AttachmentId>();
    for (const issue of issues) {
      if (signal.aborted) return;
      this.integrityCursor = issue.partId;
      for (const attachmentId of issue.attachmentIds) {
        if (this.store.getAttachment(attachmentId)) {
          this.store.markAttachmentCorrupt(attachmentId);
          affected.add(attachmentId);
        }
      }
    }
    if (issues.length < limit) this.integrityCursor = null;
    if (affected.size > 0) {
      this.recordWarning(`检测到 ${affected.size} 个消息附件引用完整性异常。`);
    }
  }

  private async repairOrphanBlobs(signal: AbortSignal, limit = 200): Promise<void> {
    if (this.orphanScanStack.length === 0) {
      const entries = await readSortedDirectory(this.blobRoot);
      this.orphanScanStack.push({ directory: this.blobRoot, entries, index: 0 });
    }
    const cutoff = this.now() - ATTACHMENT_LIMITS.unattachedTtlMs;
    let inspected = 0;
    let removed = 0;
    while (this.orphanScanStack.length > 0 && inspected < limit && !signal.aborted) {
      const frame = this.orphanScanStack.at(-1)!;
      if (frame.index >= frame.entries.length) {
        this.orphanScanStack.pop();
        continue;
      }
      const entry = frame.entries[frame.index++]!;
      inspected += 1;
      const path = join(frame.directory, entry.name);
      if (entry.isDirectory()) {
        this.orphanScanStack.push({
          directory: path,
          entries: await readSortedDirectory(path),
          index: 0,
        });
        continue;
      }
      if (!entry.isFile() || !path.endsWith(".blob")) continue;
      const storageKey = relative(this.rootDir, path);
      if (this.store.hasBlobStorageKey(storageKey)) continue;
      const info = await stat(path).catch(() => null);
      if (info?.isFile() && info.mtimeMs <= cutoff) {
        await rm(path, { force: true }).catch(() => undefined);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.recordWarning(`已清理 ${removed} 个无索引附件 Blob。`);
    }
  }

  private recordWarning(message: string): void {
    if (this.diagnosticWarnings.includes(message)) return;
    this.diagnosticWarnings.push(message);
    if (this.diagnosticWarnings.length > 50) this.diagnosticWarnings.shift();
  }

  private markUnavailable(): void {
    this.fatalError = "附件存储根目录或 Runtime 数据库当前不可用。";
  }
}

export function sanitizeFilename(value: string): string {
  const raw = basename(value.replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim() || "attachment";
  if (new TextEncoder().encode(raw).byteLength <= 255) return raw;
  const extension = extname(raw);
  const suffix = truncateUtf8(extension, 32);
  const stem = extension ? raw.slice(0, -extension.length) : raw;
  const fallbackStem = "attachment";
  const stemBudget = 255 - utf8ByteLength(suffix);
  const truncatedStem = truncateUtf8(stem, stemBudget);
  const safeStem = truncatedStem || truncateUtf8(fallbackStem, stemBudget);
  return `${safeStem}${suffix}` || fallbackStem;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = "";
  let usedBytes = 0;
  for (const char of value) {
    const charBytes = utf8ByteLength(char);
    if (usedBytes + charBytes > maxBytes) break;
    result += char;
    usedBytes += charBytes;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeDeclaredMediaType(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)
    ? normalized
    : undefined;
}

function detectMediaType(bytes: Uint8Array, declared?: string): string {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WAVE") {
    return "audio/wav";
  }
  if (starts(0x49, 0x44, 0x33) || starts(0xff, 0xfb)) return "audio/mpeg";
  return declared ?? "application/octet-stream";
}

function storageKeyForHash(hash: string): string {
  return join("blobs", "sha256", hash.slice(0, 2), hash.slice(2, 4), `${hash}.blob`);
}

async function verifyFileLength(path: string, expected: number): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expected) throw new Error("blob length mismatch");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSortedDirectory(path: string): Promise<Dirent[]> {
  return (await readdir(path, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
