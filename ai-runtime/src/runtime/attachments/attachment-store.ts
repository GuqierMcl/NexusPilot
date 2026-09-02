import type { RuntimeDatabase } from "../../storage/runtime-database";
import type { AttachmentId, BlobId, UploadId } from "../core/types";
import {
  RuntimeAttachmentError,
  type RuntimeAttachment,
  type RuntimeAttachmentUpload,
  type RuntimeBlob,
} from "./types";

interface UploadRow {
  id: string;
  filename: string;
  declared_media_type: string | null;
  declared_byte_length: number;
  state: RuntimeAttachmentUpload["state"];
  attachment_id: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

interface BlobRow {
  id: string;
  sha256: string;
  byte_length: number;
  storage_key: string;
  state: RuntimeBlob["state"];
  created_at: number;
  verified_at: number | null;
}

interface AttachmentRow {
  id: string;
  blob_id: string;
  filename: string;
  declared_media_type: string | null;
  media_type: string;
  byte_length: number;
  state: RuntimeAttachment["state"];
  created_at: number;
  updated_at: number;
  gc_after: number | null;
}

interface MessageAttachmentIntegrityRow {
  part_id: string;
  indexed_attachment_id: string | null;
  part_snapshot_attachment_id: string | null;
  message_snapshot_attachment_id: string | null;
}

export interface MessageAttachmentIntegrityIssue {
  partId: string;
  attachmentIds: AttachmentId[];
}

export class RuntimeAttachmentSqliteStore {
  constructor(private readonly db: RuntimeDatabase) {}

  createUpload(upload: RuntimeAttachmentUpload): void {
    this.db.query(
      `INSERT INTO runtime_attachment_uploads (
        id, filename, declared_media_type, declared_byte_length, state,
        attachment_id, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      upload.id,
      upload.filename,
      upload.declaredMediaType ?? null,
      upload.declaredByteLength,
      upload.state,
      upload.attachmentId ?? null,
      upload.createdAt,
      upload.updatedAt,
      upload.expiresAt,
    );
  }

  getUpload(id: UploadId): RuntimeAttachmentUpload | null {
    const row = this.db
      .query<UploadRow, [string]>("SELECT * FROM runtime_attachment_uploads WHERE id = ?")
      .get(id);
    return row ? uploadFromRow(row) : null;
  }

  countPendingUploads(now: number): number {
    return this.db
      .query<{ count: number }, [number]>(
        "SELECT COUNT(*) AS count FROM runtime_attachment_uploads WHERE state = 'pending' AND expires_at > ?",
      )
      .get(now)?.count ?? 0;
  }

  deleteUpload(id: UploadId): boolean {
    return this.db
      .query("DELETE FROM runtime_attachment_uploads WHERE id = ?")
      .run(id).changes > 0;
  }

  getAttachment(id: AttachmentId): RuntimeAttachment | null {
    const row = this.db
      .query<AttachmentRow, [string]>("SELECT * FROM runtime_attachments WHERE id = ?")
      .get(id);
    return row ? attachmentFromRow(row) : null;
  }

  getBlob(id: BlobId): RuntimeBlob | null {
    const row = this.db
      .query<BlobRow, [string]>("SELECT * FROM runtime_blobs WHERE id = ?")
      .get(id);
    return row ? blobFromRow(row) : null;
  }

  getBlobBySha256(sha256: string): RuntimeBlob | null {
    const row = this.db
      .query<BlobRow, [string]>("SELECT * FROM runtime_blobs WHERE sha256 = ?")
      .get(sha256);
    return row ? blobFromRow(row) : null;
  }

  totalStoredBlobBytes(): number {
    return this.db
      .query<{ total: number }, []>(
        "SELECT COALESCE(SUM(byte_length), 0) AS total FROM runtime_blobs",
      )
      .get()?.total ?? 0;
  }

  completeUpload(input: {
    uploadId: UploadId;
    attachment: RuntimeAttachment;
    blob: RuntimeBlob;
    now: number;
  }): RuntimeAttachment {
    let completed: RuntimeAttachment | null = null;
    const tx = this.db.transaction(() => {
      const upload = this.getUpload(input.uploadId);
      if (!upload) {
        throw new RuntimeAttachmentError("UPLOAD_NOT_FOUND", "上传会话不存在。", 404);
      }
      if (upload.state === "completed" && upload.attachmentId) {
        const existing = this.getAttachment(upload.attachmentId);
        if (!existing) {
          throw new RuntimeAttachmentError(
            "ATTACHMENT_CORRUPT",
            "上传记录关联的附件不存在。",
            500,
          );
        }
        completed = existing;
        return;
      }

      this.db.query(
        `INSERT INTO runtime_blobs (
          id, sha256, byte_length, storage_key, state, created_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sha256) DO NOTHING`,
      ).run(
        input.blob.id,
        input.blob.sha256,
        input.blob.byteLength,
        input.blob.storageKey,
        input.blob.state,
        input.blob.createdAt,
        input.blob.verifiedAt ?? null,
      );

      const storedBlob = this.getBlobBySha256(input.blob.sha256);
      if (!storedBlob || storedBlob.byteLength !== input.blob.byteLength) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_CORRUPT",
          "相同内容哈希对应的 Blob 元数据不一致。",
          500,
        );
      }

      const attachment: RuntimeAttachment = {
        ...input.attachment,
        blobId: storedBlob.id,
      };
      this.db.query(
        `INSERT INTO runtime_attachments (
          id, blob_id, filename, declared_media_type, media_type, byte_length,
          state, created_at, updated_at, gc_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attachment.id,
        attachment.blobId,
        attachment.filename,
        attachment.declaredMediaType ?? null,
        attachment.mediaType,
        attachment.byteLength,
        attachment.state,
        attachment.createdAt,
        attachment.updatedAt,
        attachment.gcAfter ?? null,
      );
      this.db.query(
        `UPDATE runtime_attachment_uploads
         SET state = 'completed', attachment_id = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      ).run(attachment.id, input.now, input.uploadId);
      completed = attachment;
    });
    tx();
    if (!completed) {
      throw new RuntimeAttachmentError("ATTACHMENT_CORRUPT", "附件事务未完成。", 500);
    }
    return completed;
  }

  countAttachmentReferences(id: AttachmentId): number {
    return this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM runtime_message_attachments WHERE attachment_id = ?",
      )
      .get(id)?.count ?? 0;
  }

  deleteUnreferencedAttachment(id: AttachmentId): RuntimeBlob | null {
    let blob: RuntimeBlob | null = null;
    const tx = this.db.transaction(() => {
      const attachment = this.getAttachment(id);
      if (!attachment) {
        return;
      }
      if (this.countAttachmentReferences(id) > 0) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_IN_USE",
          "附件正在被消息引用，不能删除。",
          409,
        );
      }
      blob = this.getBlob(attachment.blobId);
      this.db.query("DELETE FROM runtime_attachments WHERE id = ?").run(id);
    });
    tx();
    return blob;
  }

  hasBlobReferences(id: BlobId): boolean {
    return (
      (this.db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM runtime_attachments WHERE blob_id = ?",
        )
        .get(id)?.count ?? 0) > 0
    );
  }

  deleteBlobRecord(id: BlobId): void {
    this.db.query("DELETE FROM runtime_blobs WHERE id = ?").run(id);
  }

  markAttachmentCorrupt(id: AttachmentId): void {
    this.db
      .query("UPDATE runtime_attachments SET state = 'corrupt', updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  listAttachmentsForRepair(
    afterId: AttachmentId | null = null,
    limit = 200,
  ): RuntimeAttachment[] {
    return this.db
      .query<AttachmentRow, [string, number]>(
        `SELECT * FROM runtime_attachments
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(afterId ?? "", limit)
      .map(attachmentFromRow);
  }

  listMessageAttachmentIntegrityIssues(
    afterPartId: string | null = null,
    limit = 200,
  ): MessageAttachmentIntegrityIssue[] {
    return this.db
      .query<MessageAttachmentIntegrityRow, [string, number]>(
        `WITH message_file_parts AS (
           SELECT
             message.id AS message_id,
             CAST(message_part.key AS INTEGER) AS sort_index,
             COALESCE(
               json_extract(message_part.value, '$.id'),
               message.id || '#message-json#' || CAST(message_part.key AS TEXT)
             ) AS part_id,
             json_extract(message_part.value, '$.attachmentId') AS attachment_id,
             json_extract(message_part.value, '$.filename') AS filename,
             json_extract(message_part.value, '$.mediaType') AS media_type,
             json_extract(message_part.value, '$.byteLength') AS byte_length
           FROM runtime_messages AS message,
             json_each(
               CASE
                 WHEN json_valid(message.message_json) THEN message.message_json
                 ELSE '{"parts":[]}'
               END,
               '$.parts'
             ) AS message_part
           WHERE json_extract(message_part.value, '$.type') = 'file'
         ),
         candidate_parts AS (
           SELECT id AS part_id FROM runtime_message_parts WHERE type = 'file'
           UNION
           SELECT part_id FROM message_file_parts
           UNION
           SELECT part_id FROM runtime_message_attachments
         )
         SELECT
           candidate.part_id AS part_id,
           relation.attachment_id AS indexed_attachment_id,
           CASE WHEN json_valid(part.payload_json)
             THEN json_extract(part.payload_json, '$.attachmentId')
             ELSE NULL
           END AS part_snapshot_attachment_id,
           message_part.attachment_id AS message_snapshot_attachment_id
         FROM candidate_parts AS candidate
         LEFT JOIN runtime_message_parts AS part ON part.id = candidate.part_id
         LEFT JOIN message_file_parts AS message_part ON message_part.part_id = candidate.part_id
         LEFT JOIN runtime_message_attachments AS relation ON relation.part_id = part.id
         LEFT JOIN runtime_attachments AS attachment
           ON attachment.id = relation.attachment_id
         WHERE candidate.part_id > ?
           AND (
             part.id IS NULL
             OR part.type <> 'file'
             OR json_valid(part.payload_json) = 0
             OR message_part.part_id IS NULL
             OR message_part.message_id <> part.message_id
             OR message_part.sort_index <> part.sort_index
             OR relation.part_id IS NULL
             OR relation.message_id <> part.message_id
             OR relation.sort_index <> part.sort_index
             OR json_extract(
               CASE WHEN json_valid(part.payload_json) THEN part.payload_json ELSE '{}' END,
               '$.attachmentId'
             ) IS NULL
             OR json_extract(
               CASE WHEN json_valid(part.payload_json) THEN part.payload_json ELSE '{}' END,
               '$.attachmentId'
             ) IS NOT relation.attachment_id
             OR message_part.attachment_id IS NULL
             OR message_part.attachment_id IS NOT relation.attachment_id
             OR attachment.id IS NULL
             OR json_extract(
               CASE WHEN json_valid(part.payload_json) THEN part.payload_json ELSE '{}' END,
               '$.filename'
             ) IS NOT attachment.filename
             OR json_extract(
               CASE WHEN json_valid(part.payload_json) THEN part.payload_json ELSE '{}' END,
               '$.mediaType'
             ) IS NOT attachment.media_type
             OR json_extract(
               CASE WHEN json_valid(part.payload_json) THEN part.payload_json ELSE '{}' END,
               '$.byteLength'
             ) IS NOT attachment.byte_length
             OR message_part.filename IS NOT attachment.filename
             OR message_part.media_type IS NOT attachment.media_type
             OR message_part.byte_length IS NOT attachment.byte_length
           )
         ORDER BY candidate.part_id ASC
         LIMIT ?`,
      )
      .all(afterPartId ?? "", limit)
      .map((row) => ({
        partId: row.part_id,
        attachmentIds: [...new Set([
          row.indexed_attachment_id,
          row.part_snapshot_attachment_id,
          row.message_snapshot_attachment_id,
        ].filter((id): id is string => Boolean(id)))] as AttachmentId[],
      }));
  }

  listDueAttachments(now: number, limit = 50): RuntimeAttachment[] {
    return this.db
      .query<AttachmentRow, [number, number]>(
        `SELECT * FROM runtime_attachments AS attachment
         WHERE attachment.gc_after IS NOT NULL
           AND attachment.gc_after <= ?
           AND NOT EXISTS (
             SELECT 1 FROM runtime_message_attachments
             WHERE attachment_id = attachment.id
           )
         ORDER BY attachment.gc_after ASC
         LIMIT ?`,
      )
      .all(now, limit)
      .map(attachmentFromRow);
  }

  markAttachmentDeleting(id: AttachmentId): boolean {
    return this.db
      .query(
        `UPDATE runtime_attachments
         SET state = 'deleting', updated_at = ?
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM runtime_message_attachments WHERE attachment_id = ?
           )`,
      )
      .run(Date.now(), id, id).changes > 0;
  }

  deleteDeletingAttachment(id: AttachmentId): void {
    this.db
      .query(
        `DELETE FROM runtime_attachments
         WHERE id = ? AND state = 'deleting'
           AND NOT EXISTS (
             SELECT 1 FROM runtime_message_attachments WHERE attachment_id = ?
           )`,
      )
      .run(id, id);
  }

  listUnreferencedBlobs(limit = 50): RuntimeBlob[] {
    return this.db
      .query<BlobRow, [number]>(
        `SELECT * FROM runtime_blobs AS blob
         WHERE NOT EXISTS (
           SELECT 1 FROM runtime_attachments WHERE blob_id = blob.id
         )
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit)
      .map(blobFromRow);
  }

  markBlobState(id: BlobId, state: RuntimeBlob["state"]): void {
    this.db.query("UPDATE runtime_blobs SET state = ? WHERE id = ?").run(state, id);
  }

  markBlobVerified(id: BlobId, verifiedAt: number): void {
    this.db
      .query("UPDATE runtime_blobs SET verified_at = ? WHERE id = ?")
      .run(verifiedAt, id);
  }

  markBlobAndAttachmentsCorrupt(id: BlobId): void {
    const tx = this.db.transaction(() => {
      this.markBlobState(id, "corrupt");
      this.db
        .query(
          "UPDATE runtime_attachments SET state = 'corrupt', updated_at = ? WHERE blob_id = ?",
        )
        .run(Date.now(), id);
    });
    tx();
  }

  listBlobStorageKeys(): string[] {
    return this.db
      .query<{ storage_key: string }, []>("SELECT storage_key FROM runtime_blobs")
      .all()
      .map((row) => row.storage_key);
  }

  hasBlobStorageKey(storageKey: string): boolean {
    return Boolean(
      this.db
        .query<{ present: number }, [string]>(
          "SELECT 1 AS present FROM runtime_blobs WHERE storage_key = ? LIMIT 1",
        )
        .get(storageKey),
    );
  }

  deleteExpiredUploads(now: number, limit = 50): number {
    return this.db
      .query(
        `DELETE FROM runtime_attachment_uploads
         WHERE id IN (
           SELECT id FROM runtime_attachment_uploads
           WHERE expires_at <= ?
           ORDER BY expires_at ASC, id ASC
           LIMIT ?
         )`,
      )
      .run(now, limit).changes;
  }
}

function uploadFromRow(row: UploadRow): RuntimeAttachmentUpload {
  return {
    id: row.id as UploadId,
    filename: row.filename,
    ...(row.declared_media_type ? { declaredMediaType: row.declared_media_type } : {}),
    declaredByteLength: row.declared_byte_length,
    state: row.state,
    ...(row.attachment_id ? { attachmentId: row.attachment_id as AttachmentId } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function attachmentFromRow(row: AttachmentRow): RuntimeAttachment {
  return {
    id: row.id as AttachmentId,
    blobId: row.blob_id as BlobId,
    filename: row.filename,
    ...(row.declared_media_type ? { declaredMediaType: row.declared_media_type } : {}),
    mediaType: row.media_type,
    byteLength: row.byte_length,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.gc_after !== null ? { gcAfter: row.gc_after } : {}),
  };
}

function blobFromRow(row: BlobRow): RuntimeBlob {
  return {
    id: row.id as BlobId,
    sha256: row.sha256,
    byteLength: row.byte_length,
    storageKey: row.storage_key,
    state: row.state,
    createdAt: row.created_at,
    ...(row.verified_at !== null ? { verifiedAt: row.verified_at } : {}),
  };
}
