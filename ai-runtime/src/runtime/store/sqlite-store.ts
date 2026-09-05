import { createHash } from "node:crypto";
import { ZodError } from "zod";
import type { RuntimeDatabase } from "../../storage/runtime-database";
import { runtimeEventToEnvelope } from "../events/event-envelope";
import type { RuntimeEventBus } from "../events/event-bus";
import {
  conversationSchema,
  contextCheckpointSchema,
  contextPlanSchema,
  contextUsageSchema,
  eventSchema,
  messageSchema,
  partSchema,
  permissionSchema,
  runSchema,
  toolCallAuthorizationSnapshotSchema,
  traceEventSchema,
} from "../core/schemas";
import type {
  Conversation,
  ConversationId,
  AssistantMessage,
  Event,
  FilePart,
  Message,
  MessageId,
  Part,
  Permission,
  PermissionId,
  Run,
  RunId,
  RuntimeHistoryDiagnostic,
  UserMessage,
  ToolCall,
  ToolCallId,
  TraceEvent,
} from "../core/types";
import type {
  ContextCheckpoint,
  ContextCheckpointCommit,
  ContextPlan,
  ContextPlanCommit,
  ContextPreparationClaim,
  ContextPreparationClaimRequest,
  ContextPreparationClaimRelease,
  ContextPreparationClaimResult,
  ContextUsage,
  RuntimeContextDiagnostic,
} from "../context/types";
import { ContextPreparationLeaseLostError } from "../context/types";
import { computeContextCoverageSourceState } from "../context/boundary-validation";
import {
  computeContextLineageHash,
  isContextCheckpointParentChainUsable,
} from "../context/planner";
import { buildRuntimeSafetyState } from "../context/safety-state";
import {
  CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION,
  CONTEXT_CHECKPOINT_FORMAT_VERSION,
  PROVIDER_NEUTRAL_CONTEXT_KIND,
  RUNTIME_SAFETY_STATE_VERSION,
} from "../context/policy";
import { ATTACHMENT_LIMITS, RuntimeAttachmentError } from "../attachments";

function encode(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function decode<T>(value: string | null | undefined): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return JSON.parse(value) as T;
}

interface ConversationRow {
  id: string;
  title: string;
  version: string;
  status_json: string;
  active_head_run_id: string | null;
  revision: number;
  parent_id: string | null;
  summary_json: string | null;
  share_json: string | null;
  time_json: string;
  metadata_json: string | null;
}

interface RunRow {
  id: string;
  conversation_id: string;
  parent_run_id: string | null;
  supersedes_run_id: string | null;
  parent_message_id: string | null;
  assistant_message_id: string | null;
  agent_mode: Run["agentMode"];
  provider_id: string;
  model_id: string;
  status: Run["status"];
  input_json: string;
  output_json: string | null;
  usage_json: string | null;
  cost_json: string | null;
  finish: Run["finish"] | null;
  error_json: string | null;
  time_json: string;
  limits_json: string;
  metadata_json: string | null;
}

interface MessageRow {
  message_json: string;
}

interface PartRow {
  payload_json: string;
}

interface MessageFilePartRow {
  id: string;
  message_id: string;
  type: string;
  sort_index: number;
  payload_json: string;
  indexed_attachment_id: string | null;
  indexed_message_id: string | null;
  indexed_sort_index: number | null;
}

interface ToolCallRow {
  id: string;
  conversation_id: string;
  run_id: string;
  message_id: string;
  part_id: string | null;
  tool_name: string;
  state: ToolCall["state"];
  input_json: string;
  permission_id: string | null;
  result_json: string | null;
  error_json: string | null;
  time_json: string;
  metadata_json: string | null;
  authorization_json: string | null;
}

interface PermissionRow {
  id: string;
  conversation_id: string;
  run_id: string;
  message_id: string;
  tool_call_id: string;
  status: Permission["status"];
  tool_id: string;
  title: string;
  input_summary: string | null;
  risk_json: string;
  confirmation_json: string;
  presentation_json: string | null;
  adapter_json: string | null;
  decision_json: string | null;
  created_at: number;
}

interface EventRow {
  payload_json: string;
}

interface TraceRow {
  id: string;
  conversation_id: string | null;
  run_id: string | null;
  type: TraceEvent["type"];
  level: TraceEvent["level"];
  payload_json: string;
  time: number;
}

interface RuntimeHistoryDiagnosticRow {
  id: string;
  conversation_id: string;
  code: RuntimeHistoryDiagnostic["code"];
  details_json: string;
  created_at: number;
}

interface ContextPayloadRow {
  payload_json: string;
}

interface ContextCheckpointRow extends ContextPayloadRow {
  id: string;
  conversation_id: string;
  coverage_through_run_id: string;
  source_head_run_id: string;
  source_conversation_revision: number;
  parent_checkpoint_id: string | null;
  format_version: string;
  compatibility_kind: string;
  compatibility_version: number;
  created_at: number;
}

interface RuntimeContextDiagnosticRow {
  id: string;
  code: RuntimeContextDiagnostic["code"];
  conversation_id: string | null;
  checkpoint_id: string | null;
  run_id: string | null;
  reason: string;
  details_json: string;
  created_at: number;
}

interface ContextPreparationClaimRow {
  run_id: string;
  request_index: number;
  request_hash: string;
  owner_id: string;
  fencing_token: number;
  claimed_at: number;
  expires_at: number;
}

interface ResolvedLineageRun {
  run: Run;
  userMessage: UserMessage;
  assistantMessage: AssistantMessage;
}

export class RuntimeHistoryIntegrityError extends Error {
  constructor(
    readonly code: Exclude<RuntimeHistoryDiagnostic["code"], "LEGACY_DAG_BACKFILL_INVALID">,
    readonly conversationId: ConversationId,
    readonly runId: RunId,
    readonly details: Record<string, unknown>,
  ) {
    super(`Runtime history integrity error: ${code}`);
    this.name = "RuntimeHistoryIntegrityError";
  }
}

export class RuntimeConversationRevisionConflictError extends Error {
  constructor(
    readonly conversationId: ConversationId,
    readonly expectedRevision: number,
    readonly actualRevision: number | null,
  ) {
    super(
      `Conversation ${conversationId} revision conflict: expected ${expectedRevision}, ` +
      `actual ${actualRevision ?? "missing"}`,
    );
    this.name = "RuntimeConversationRevisionConflictError";
  }
}

class ContextCheckpointRejectedError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "ContextCheckpointRejectedError";
  }
}

export interface ListConversationsOptions {
  limit?: number;
  withMessagesOnly?: boolean;
}

export interface RuntimeSqliteStoreOptions {
  eventBus?: RuntimeEventBus;
  now?: () => number;
}

export interface RuntimeToolPermissionRequestCommit {
  toolCall: ToolCall;
  permission: Permission;
  requestedAt: number;
  eventIds: {
    tool: Event["id"];
    permission: Event["id"];
    run: Event["id"];
    conversation: Event["id"];
  };
}

export interface RuntimePermissionContinuationCommit {
  runId: RunId;
  responses: readonly {
    permissionId: PermissionId;
    approved: boolean;
    confirmationText?: string;
    reason?: string;
  }[];
  continuedAt: number;
  eventIds: {
    permissions: readonly Event["id"][];
    tools: readonly Event["id"][];
    run: Event["id"];
    conversation: Event["id"];
  };
}

export class RuntimeSqliteStore {
  private closed = false;
  private readonly invalidCheckpointIds = new Set<string>();

  constructor(
    private readonly db: RuntimeDatabase,
    private readonly options: RuntimeSqliteStoreOptions = {},
  ) {
    this.scanContextIntegrityAtStartup();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.db.close();
    this.closed = true;
  }

  commitRunStart(input: {
    expectedConversationRevision?: number;
    conversation: Conversation;
    userMessage: Message;
    run: Run;
    assistantMessage: Message;
    events: Event[];
    traces: TraceEvent[];
  }): void {
    const conversation = conversationSchema.parse(input.conversation) as Conversation;
    const userMessage = messageSchema.parse(input.userMessage) as Message;
    const run = runSchema.parse(input.run) as Run;
    const assistantMessage = messageSchema.parse(input.assistantMessage) as Message;
    const events = input.events.map((event) => eventSchema.parse(event) as Event);
    const traces = input.traces.map((trace) => traceEventSchema.parse(trace) as TraceEvent);

    const tx = this.db.transaction(() => {
      if (input.expectedConversationRevision === undefined) {
        if (conversation.revision !== 1) {
          throw new Error(
            `Initial Run start must set Conversation revision to 1, got ` +
            conversation.revision,
          );
        }
        this.insertConversation(conversation);
      } else {
        if (conversation.revision !== input.expectedConversationRevision + 1) {
          throw new Error(
            `Run start must advance Conversation revision exactly once from ` +
            `${input.expectedConversationRevision} to ${conversation.revision}`,
          );
        }
        this.updateConversationAtRevision(
          conversation,
          input.expectedConversationRevision,
        );
      }

      this.saveMessage(userMessage);
      this.saveRun(run);
      this.saveMessage(assistantMessage);
      events.forEach((event) => this.insertEvent(event));
      traces.forEach((trace) => this.appendTrace(trace));
    });

    try {
      tx();
    } catch (error) {
      this.persistAttachmentCorruption(error);
      throw error;
    }
    events.forEach((event) => this.options.eventBus?.publish(runtimeEventToEnvelope(event)));
  }

  saveConversation(conversation: Conversation): void {
    const parsed = conversationSchema.parse(conversation) as Conversation;

    this.db
      .query(
        `INSERT INTO runtime_conversations (
          id, title, version, status_json, active_head_run_id, revision,
          parent_id, summary_json, share_json, time_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          version = excluded.version,
          status_json = excluded.status_json,
          active_head_run_id = excluded.active_head_run_id,
          revision = excluded.revision,
          parent_id = excluded.parent_id,
          summary_json = excluded.summary_json,
          share_json = excluded.share_json,
          time_json = excluded.time_json,
          metadata_json = excluded.metadata_json`,
      )
      .run(
        parsed.id,
        parsed.title,
        parsed.version,
        encode(parsed.status),
        parsed.activeHeadRunId ?? null,
        parsed.revision,
        parsed.parentId ?? null,
        parsed.summary ? encode(parsed.summary) : null,
        parsed.share ? encode(parsed.share) : null,
        encode(parsed.time),
        parsed.metadata ? encode(parsed.metadata) : null,
      );
  }

  getConversation(id: ConversationId): Conversation | null {
    const row = this.db
      .query<ConversationRow, [string]>("SELECT * FROM runtime_conversations WHERE id = ?")
      .get(id);

    return row ? conversationFromRow(row) : null;
  }

  deleteConversation(id: ConversationId): Conversation | null {
    const existing = this.getConversation(id);
    if (!existing) {
      return null;
    }

    const tx = this.db.transaction(() => {
      const attachmentIds = this.db
        .query<{ attachment_id: string }, [string]>(
          `SELECT DISTINCT rma.attachment_id
           FROM runtime_message_attachments AS rma
           JOIN runtime_messages AS message ON message.id = rma.message_id
           WHERE message.conversation_id = ?`,
        )
        .all(id)
        .map((row) => row.attachment_id);
      this.db.query("DELETE FROM runtime_conversations WHERE id = ?").run(id);
      this.scheduleUnreferencedAttachments(attachmentIds);
    });
    tx();

    return existing;
  }

  listConversations(options: ListConversationsOptions = {}): Conversation[] {
    const limit = normalizeListLimit(options.limit);
    const where = options.withMessagesOnly
      ? `WHERE EXISTS (
          SELECT 1 FROM runtime_messages
          WHERE runtime_messages.conversation_id = runtime_conversations.id
        )`
      : "";

    return this.db
      .query<ConversationRow, [number]>(
        `SELECT * FROM runtime_conversations
        ${where}
        ORDER BY
          json_extract(time_json, '$.updated') DESC,
          json_extract(time_json, '$.created') DESC,
          id DESC
        LIMIT ?`,
      )
      .all(limit)
      .map(conversationFromRow);
  }

  saveRun(run: Run): void {
    const parsed = runSchema.parse(run) as Run;

    this.db
      .query(
        `INSERT INTO runtime_runs (
          id, conversation_id, parent_run_id, supersedes_run_id,
          parent_message_id, assistant_message_id, agent_mode,
          provider_id, model_id, status, input_json, output_json, usage_json, cost_json,
          finish, error_json, time_json, limits_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          parent_message_id = excluded.parent_message_id,
          assistant_message_id = excluded.assistant_message_id,
          status = excluded.status,
          input_json = excluded.input_json,
          output_json = excluded.output_json,
          usage_json = excluded.usage_json,
          cost_json = excluded.cost_json,
          finish = excluded.finish,
          error_json = excluded.error_json,
          time_json = excluded.time_json,
          limits_json = excluded.limits_json,
          metadata_json = excluded.metadata_json`,
      )
      .run(
        parsed.id,
        parsed.conversationId,
        parsed.parentRunId ?? null,
        parsed.supersedesRunId ?? null,
        parsed.parentMessageId ?? null,
        parsed.assistantMessageId ?? null,
        parsed.agentMode,
        parsed.providerId,
        parsed.modelId,
        parsed.status,
        encode(parsed.input),
        parsed.output ? encode(parsed.output) : null,
        parsed.usage ? encode(parsed.usage) : null,
        parsed.cost ? encode(parsed.cost) : null,
        parsed.finish ?? null,
        parsed.error ? encode(parsed.error) : null,
        encode(parsed.time),
        encode(parsed.limits),
        parsed.metadata ? encode(parsed.metadata) : null,
      );
  }

  getRun(id: RunId): Run | null {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runtime_runs WHERE id = ?").get(id);

    return row ? runFromRow(row) : null;
  }

  listRunsByConversation(conversationId: ConversationId): Run[] {
    return this.db
      .query<RunRow, [string]>(
        `SELECT * FROM runtime_runs
        WHERE conversation_id = ?
        ORDER BY
          json_extract(time_json, '$.created') ASC,
          id ASC`,
      )
      .all(conversationId)
      .map(runFromRow);
  }

  listActiveRuns(): Run[] {
    return this.db
      .query<RunRow, []>(
        `SELECT * FROM runtime_runs
        WHERE status IN ('running', 'waiting_for_tool', 'waiting_for_permission')
        ORDER BY
          json_extract(time_json, '$.created') ASC,
          id ASC`,
      )
      .all()
      .map(runFromRow);
  }

  saveMessage(message: Message): void {
    const parsed = messageSchema.parse(message) as Message;
    const insertMessage = this.db.query(
      `INSERT INTO runtime_messages (
        id, conversation_id, role, agent_mode, run_id, parent_id, provider_id, model_id,
        scope, summary_json, status_json, usage_json, cost_json, finish, error_json,
        time_json, metadata_json, message_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        agent_mode = excluded.agent_mode,
        run_id = excluded.run_id,
        parent_id = excluded.parent_id,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        scope = excluded.scope,
        summary_json = excluded.summary_json,
        status_json = excluded.status_json,
        usage_json = excluded.usage_json,
        cost_json = excluded.cost_json,
        finish = excluded.finish,
        error_json = excluded.error_json,
        time_json = excluded.time_json,
        metadata_json = excluded.metadata_json,
        message_json = excluded.message_json`,
    );
    const deleteParts = this.db.query("DELETE FROM runtime_message_parts WHERE message_id = ?");
    const insertPart = this.db.query(
      `INSERT INTO runtime_message_parts (
        id, conversation_id, message_id, type, sort_index, payload_json, time_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAttachmentReference = this.db.query(
      `INSERT INTO runtime_message_attachments (
        part_id, message_id, attachment_id, sort_index
      ) VALUES (?, ?, ?, ?)`,
    );

    const tx = this.db.transaction((record: Message) => {
      const fileParts = record.parts.filter(
        (part): part is FilePart => part.type === "file",
      );
      if (fileParts.length > ATTACHMENT_LIMITS.maxMessageAttachments) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_COUNT_EXCEEDED",
          "单条消息最多可包含 10 个附件。",
          422,
        );
      }
      if (new Set(fileParts.map((part) => part.attachmentId)).size !== fileParts.length) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_COUNT_EXCEEDED",
          "同一条消息不能重复引用同一个附件。",
          422,
        );
      }
      if (
        fileParts.reduce((sum, part) => sum + part.byteLength, 0) >
        ATTACHMENT_LIMITS.maxMessageAttachmentBytes
      ) {
        throw new RuntimeAttachmentError(
          "ATTACHMENT_TOTAL_SIZE_EXCEEDED",
          "单条消息的附件总量超过 50 MiB 限制。",
          413,
        );
      }
      const previousAttachmentIds = this.db
        .query<{ attachment_id: string }, [string]>(
          "SELECT attachment_id FROM runtime_message_attachments WHERE message_id = ?",
        )
        .all(record.id)
        .map((row) => row.attachment_id);
      insertMessage.run(
        record.id,
        record.conversationId,
        record.role,
        record.role === "user"
          ? record.agentMode
          : record.role === "assistant"
            ? record.agentMode
            : null,
        record.role === "assistant" ? record.runId : null,
        record.role === "assistant" ? record.parentId : null,
        record.role === "assistant"
          ? record.providerId
          : record.role === "user"
            ? record.model?.providerId ?? null
            : null,
        record.role === "assistant"
          ? record.modelId
          : record.role === "user"
            ? record.model?.modelId ?? null
            : null,
        record.role === "system" ? record.scope : null,
        record.role === "user" && record.summary ? encode(record.summary) : null,
        record.role === "assistant" ? encode(record.status) : null,
        record.role === "assistant" && record.usage ? encode(record.usage) : null,
        record.role === "assistant" && record.cost ? encode(record.cost) : null,
        record.role === "assistant" ? record.finish ?? null : null,
        record.role === "assistant" && record.error ? encode(record.error) : null,
        encode(record.time),
        record.metadata ? encode(record.metadata) : null,
        encode(record),
      );

      deleteParts.run(record.id);
      record.parts.forEach((part, index) => {
        insertPart.run(
          part.id,
          part.conversationId,
          part.messageId,
          part.type,
          index,
          encode(part),
          part.time ? encode(part.time) : null,
          part.metadata ? encode(part.metadata) : null,
        );
        if (part.type === "file") {
          this.assertFilePartAttachment(part);
          insertAttachmentReference.run(part.id, record.id, part.attachmentId, index);
          this.db
            .query("UPDATE runtime_attachments SET gc_after = NULL, updated_at = ? WHERE id = ?")
            .run(Date.now(), part.attachmentId);
        }
      });
      this.scheduleUnreferencedAttachments(previousAttachmentIds);
    });

    try {
      tx(parsed);
    } catch (error) {
      this.persistAttachmentCorruption(error);
      throw error;
    }
  }

  getMessage(id: MessageId): Message | null {
    const row = this.db
      .query<MessageRow, [string]>("SELECT message_json FROM runtime_messages WHERE id = ?")
      .get(id);
    if (!row) return null;
    return this.parseAndAssertLoadedMessage(row.message_json);
  }

  listTranscriptMessages(conversationId: ConversationId): Message[] {
    return this.db
      .query<MessageRow, [string]>(
        `SELECT message_json FROM runtime_messages
        WHERE conversation_id = ?
        ORDER BY
          json_extract(time_json, '$.created'),
          CASE role
            WHEN 'system' THEN 0
            WHEN 'user' THEN 1
            WHEN 'assistant' THEN 2
            ELSE 3
          END,
          id`,
      )
      .all(conversationId)
      .map((row) => this.parseAndAssertLoadedMessage(row.message_json));
  }

  /** @deprecated Use an explicit transcript or lineage history view. */
  listMessages(conversationId: ConversationId): Message[] {
    return this.listTranscriptMessages(conversationId);
  }

  listLineageRuns(conversationId: ConversationId, headRunId: RunId): Run[] {
    return this.resolveLineage(conversationId, headRunId).map(({ run }) => run);
  }

  listLineageMessages(conversationId: ConversationId, headRunId: RunId): Message[] {
    return this.resolveLineage(conversationId, headRunId).flatMap(
      ({ userMessage, assistantMessage }) => [userMessage, assistantMessage],
    );
  }

  listActiveLineageMessages(conversationId: ConversationId): Message[] {
    const conversation = this.getConversation(conversationId);
    if (!conversation?.activeHeadRunId) {
      return [];
    }
    return this.listLineageMessages(conversationId, conversation.activeHeadRunId);
  }

  listRunAlternatives(runId: RunId): Run[] {
    const run = this.getRun(runId);
    if (!run) {
      return [];
    }

    return this.db
      .query<RunRow, [string, string | null]>(
        `SELECT * FROM runtime_runs
         WHERE conversation_id = ? AND parent_run_id IS ?
         ORDER BY json_extract(time_json, '$.created') ASC, id ASC`,
      )
      .all(run.conversationId, run.parentRunId ?? null)
      .map(runFromRow);
  }

  listHistoryDiagnostics(conversationId?: ConversationId): RuntimeHistoryDiagnostic[] {
    const rows = conversationId
      ? this.db
          .query<RuntimeHistoryDiagnosticRow, [string]>(
            `SELECT * FROM runtime_history_diagnostics
             WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(conversationId)
      : this.db
          .query<RuntimeHistoryDiagnosticRow, []>(
            "SELECT * FROM runtime_history_diagnostics ORDER BY created_at ASC, id ASC",
          )
          .all();
    return rows.map(historyDiagnosticFromRow);
  }

  listContextCheckpoints(conversationId: ConversationId): ContextCheckpoint[] {
    return this.db
      .query<ContextCheckpointRow, [string]>(
        `SELECT * FROM runtime_context_checkpoints
         WHERE conversation_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(conversationId)
      .flatMap((row) => {
        if (this.invalidCheckpointIds.has(row.id)) return [];
        try {
          const parsed = contextCheckpointSchema.safeParse(JSON.parse(row.payload_json));
          return parsed.success ? [parsed.data as ContextCheckpoint] : [];
        } catch {
          return [];
        }
      });
  }

  contextDiagnostics(): {
    status: "ok" | "warning" | "unavailable";
    warnings: Array<{
      code: RuntimeContextDiagnostic["code"];
      conversationId?: ConversationId;
      checkpointId?: ContextCheckpoint["id"];
      runId?: RunId;
      reason: string;
    }>;
  } {
    try {
      const rows = this.db
        .query<RuntimeContextDiagnosticRow, []>(
          `SELECT * FROM runtime_context_diagnostics
           WHERE code IN (
             'CHECKPOINT_STARTUP_WARNING',
             'CHECKPOINT_STARTUP_REJECTED',
             'CONTEXT_PREPARATION_INTERRUPTED'
           )
           ORDER BY created_at ASC, id ASC`,
        )
        .all();
      const warnings = rows.map((row) => ({
        code: row.code,
        ...(row.conversation_id
          ? { conversationId: row.conversation_id as ConversationId }
          : {}),
        ...(row.checkpoint_id
          ? { checkpointId: row.checkpoint_id as ContextCheckpoint["id"] }
          : {}),
        ...(row.run_id ? { runId: row.run_id as RunId } : {}),
        reason: row.reason,
      }));
      return { status: warnings.length > 0 ? "warning" : "ok", warnings };
    } catch {
      return { status: "unavailable", warnings: [] };
    }
  }

  private scanContextIntegrityAtStartup(): void {
    try {
      const checkpointRows = this.db
        .query<ContextCheckpointRow, []>(
          "SELECT * FROM runtime_context_checkpoints ORDER BY created_at ASC, id ASC",
        )
        .all();
      const startupCheckpoints = new Map<string, {
        checkpoint: ContextCheckpoint;
        lineage: Run[];
        row: ContextCheckpointRow;
      }>();
      for (const row of checkpointRows) {
        const inspected = this.inspectStartupCheckpoint(row);
        if (inspected) startupCheckpoints.set(row.id, { ...inspected, row });
      }
      const checkpointsById = new Map(
        [...startupCheckpoints.values()].map(({ checkpoint }) => [checkpoint.id, checkpoint]),
      );
      for (const { checkpoint, lineage, row } of startupCheckpoints.values()) {
        const supported = checkpoint.formatVersion === CONTEXT_CHECKPOINT_FORMAT_VERSION
          && checkpoint.compatibility.kind === PROVIDER_NEUTRAL_CONTEXT_KIND
          && checkpoint.compatibility.version === CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
          && checkpoint.safetyStateVersion === RUNTIME_SAFETY_STATE_VERSION;
        if (
          supported
          && checkpoint.parentCheckpointId
          && !isContextCheckpointParentChainUsable(checkpoint, checkpointsById, lineage)
        ) {
          this.rejectStartupCheckpoint(row, "dangling_parent");
        }
      }

      const claims = this.db
        .query<ContextPreparationClaimRow, []>(
          `SELECT run_id, request_index, request_hash, owner_id, fencing_token, claimed_at, expires_at
           FROM runtime_context_preparation_claims
           ORDER BY claimed_at ASC, run_id ASC, request_index ASC`,
        )
        .all();
      for (const claim of claims) {
        let conversationId: ConversationId | undefined;
        try {
          conversationId = this.getRun(claim.run_id as RunId)?.conversationId;
        } catch {
          // A damaged Run must not prevent startup diagnostics for the leftover claim.
        }
        this.insertContextDiagnostic({
          code: "CONTEXT_PREPARATION_INTERRUPTED",
          ...(conversationId ? { conversationId } : {}),
          runId: claim.run_id as RunId,
          reason: "interrupted_generation",
          details: {
            requestIndex: claim.request_index,
            claimedAt: claim.claimed_at,
            expiresAt: claim.expires_at,
          },
        });
      }
    } catch {
      // Context diagnostics are fail-safe: unrelated Runtime startup remains available.
    }
  }

  private inspectStartupCheckpoint(
    row: ContextCheckpointRow,
  ): { checkpoint: ContextCheckpoint; lineage: Run[] } | null {
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch {
      this.rejectStartupCheckpoint(row, "invalid_payload");
      return null;
    }
    const parsed = contextCheckpointSchema.safeParse(raw);
    if (!parsed.success) {
      this.rejectStartupCheckpoint(row, "invalid_payload");
      return null;
    }
    const checkpoint = parsed.data as ContextCheckpoint;
    if (
      checkpoint.id !== row.id
      || checkpoint.conversationId !== row.conversation_id
      || checkpoint.coverageThroughRunId !== row.coverage_through_run_id
      || checkpoint.sourceHeadRunId !== row.source_head_run_id
      || checkpoint.sourceConversationRevision !== row.source_conversation_revision
      || (checkpoint.parentCheckpointId ?? null) !== row.parent_checkpoint_id
      || checkpoint.formatVersion !== row.format_version
      || checkpoint.compatibility.kind !== row.compatibility_kind
      || checkpoint.compatibility.version !== row.compatibility_version
      || checkpoint.time.created !== row.created_at
    ) {
      this.rejectStartupCheckpoint(row, "column_mismatch");
      return null;
    }

    if (checkpoint.formatVersion !== CONTEXT_CHECKPOINT_FORMAT_VERSION) {
      this.insertContextDiagnostic({
        code: "CHECKPOINT_STARTUP_WARNING",
        conversationId: checkpoint.conversationId,
        checkpointId: checkpoint.id,
        runId: checkpoint.sourceHeadRunId,
        reason: "unsupported_format",
        details: { formatVersion: checkpoint.formatVersion },
      });
    } else if (
      checkpoint.compatibility.kind !== PROVIDER_NEUTRAL_CONTEXT_KIND
      || checkpoint.compatibility.version !== CONTEXT_CHECKPOINT_COMPATIBILITY_VERSION
      || checkpoint.safetyStateVersion !== RUNTIME_SAFETY_STATE_VERSION
    ) {
      this.insertContextDiagnostic({
        code: "CHECKPOINT_STARTUP_WARNING",
        conversationId: checkpoint.conversationId,
        checkpointId: checkpoint.id,
        runId: checkpoint.sourceHeadRunId,
        reason: "unsupported_compatibility",
        details: {
          compatibilityKind: checkpoint.compatibility.kind,
          compatibilityVersion: checkpoint.compatibility.version,
          safetyStateVersion: checkpoint.safetyStateVersion,
        },
      });
    }

    let coverageRun: Run | null = null;
    let sourceRun: Run | null = null;
    try {
      coverageRun = this.getRun(checkpoint.coverageThroughRunId);
      sourceRun = this.getRun(checkpoint.sourceHeadRunId);
    } catch {
      this.rejectStartupCheckpoint(row, "invalid_run_payload");
      return null;
    }
    if (!coverageRun || coverageRun.conversationId !== checkpoint.conversationId) {
      this.rejectStartupCheckpoint(row, "missing_coverage_run");
      return null;
    }
    if (!sourceRun || sourceRun.conversationId !== checkpoint.conversationId) {
      this.rejectStartupCheckpoint(row, "missing_source_run");
      return null;
    }

    let lineage: Run[];
    try {
      lineage = this.listLineageRuns(checkpoint.conversationId, checkpoint.sourceHeadRunId);
    } catch {
      this.rejectStartupCheckpoint(row, "invalid_source_lineage");
      return null;
    }
    if (!lineage.some((run) => run.id === checkpoint.coverageThroughRunId)) {
      this.rejectStartupCheckpoint(row, "coverage_not_active_ancestor");
      return null;
    }
    if (
      computeContextLineageHash(lineage, checkpoint.coverageThroughRunId)
      !== checkpoint.lineageHash
    ) {
      this.rejectStartupCheckpoint(row, "lineage_hash_mismatch");
      return null;
    }
    return { checkpoint, lineage };
  }

  private rejectStartupCheckpoint(row: ContextCheckpointRow, reason: string): void {
    this.invalidCheckpointIds.add(row.id);
    this.insertContextDiagnostic({
      code: "CHECKPOINT_STARTUP_REJECTED",
      ...(row.conversation_id.startsWith("conv_")
        ? { conversationId: row.conversation_id as ConversationId }
        : {}),
      ...(row.id.startsWith("ckpt_")
        ? { checkpointId: row.id as ContextCheckpoint["id"] }
        : {}),
      ...(row.source_head_run_id.startsWith("run_")
        ? { runId: row.source_head_run_id as RunId }
        : {}),
      reason,
      details: {},
    });
  }

  private insertContextDiagnostic(
    input: Omit<RuntimeContextDiagnostic, "id" | "time">,
  ): void {
    const identity = encode({
      code: input.code,
      conversationId: input.conversationId,
      checkpointId: input.checkpointId,
      runId: input.runId,
      reason: input.reason,
      details: input.details,
    });
    const id = `ctxdiag_${createHash("sha256").update(identity).digest("hex")}`;
    const lastCreatedAt = this.db
      .query<{ created_at: number | null }, []>(
        "SELECT MAX(created_at) AS created_at FROM runtime_context_diagnostics",
      )
      .get()?.created_at;
    const createdAt = Math.max(
      this.contextPreparationNow(),
      (lastCreatedAt ?? -1) + 1,
    );
    this.db
      .query(
        `INSERT OR IGNORE INTO runtime_context_diagnostics (
          id, code, conversation_id, checkpoint_id, run_id, reason, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.code,
        input.conversationId ?? null,
        input.checkpointId ?? null,
        input.runId ?? null,
        input.reason,
        encode(input.details),
        createdAt,
      );
  }

  getContextPlan(id: ContextPlan["id"]): ContextPlan | null {
    const row = this.db
      .query<ContextPayloadRow, [string]>(
        "SELECT payload_json FROM runtime_context_plans WHERE id = ?",
      )
      .get(id);
    return row ? contextPlanSchema.parse(JSON.parse(row.payload_json)) as ContextPlan : null;
  }

  getContextPlanByRunRequest(runId: RunId, requestIndex: number): ContextPlan | null {
    const row = this.db
      .query<ContextPayloadRow, [string, number]>(
        `SELECT payload_json FROM runtime_context_plans
         WHERE run_id = ? AND request_index = ?`,
      )
      .get(runId, requestIndex);
    return row ? contextPlanSchema.parse(JSON.parse(row.payload_json)) as ContextPlan : null;
  }

  getContextPreparationBrokerKey(): object {
    return this.db;
  }

  getContextPreparationClaim(
    runId: RunId,
    requestIndex: number,
  ): ContextPreparationClaim | null {
    assertContextPreparationRequestKey(runId, requestIndex);
    const row = this.db
      .query<ContextPreparationClaimRow, [string, number]>(
        `SELECT run_id, request_index, request_hash, owner_id, fencing_token, claimed_at, expires_at
         FROM runtime_context_preparation_claims
         WHERE run_id = ? AND request_index = ?`,
      )
      .get(runId, requestIndex);
    return row ? contextPreparationClaimFromRow(row) : null;
  }

  claimContextPreparation(request: ContextPreparationClaimRequest): ContextPreparationClaimResult {
    assertContextPreparationClaimRequest(request);
    if (!this.getRun(request.runId)) {
      throw new Error(`Context preparation claim Run was not found: ${request.runId}`);
    }
    const claimedAt = this.contextPreparationNow();
    const expiresAt = claimedAt + request.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("Context preparation claim expiry is invalid");
    }
    const claim: ContextPreparationClaim = {
      runId: request.runId,
      requestIndex: request.requestIndex,
      requestHash: request.requestHash,
      ownerId: request.ownerId,
      fencingToken: 1,
      claimedAt,
      expiresAt,
    };
    const tx = this.db.transaction((): ContextPreparationClaimResult => {
      const inserted = this.db
        .query(
          `INSERT OR IGNORE INTO runtime_context_preparation_claims (
            run_id, request_index, request_hash, owner_id, fencing_token, claimed_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          claim.runId,
          claim.requestIndex,
          claim.requestHash,
          claim.ownerId,
          claim.fencingToken,
          claim.claimedAt,
          claim.expiresAt,
        );
      if (inserted.changes > 0) return { status: "acquired", claim };

      const existing = this.getContextPreparationClaim(claim.runId, claim.requestIndex);
      if (!existing) {
        throw new Error("Context preparation claim disappeared during arbitration");
      }
      if (existing.requestHash !== claim.requestHash) {
        return { status: "conflict", claim: existing };
      }
      if (existing.expiresAt > claim.claimedAt) {
        return { status: "in_progress", claim: existing };
      }
      const reclaimed = this.db
        .query(
          `UPDATE runtime_context_preparation_claims
           SET owner_id = ?, fencing_token = fencing_token + 1, claimed_at = ?, expires_at = ?
           WHERE run_id = ? AND request_index = ?
             AND request_hash = ? AND expires_at <= ?`,
        )
        .run(
          claim.ownerId,
          claim.claimedAt,
          claim.expiresAt,
          claim.runId,
          claim.requestIndex,
          claim.requestHash,
          claim.claimedAt,
        );
      if (reclaimed.changes > 0) {
        const acquired = this.getContextPreparationClaim(claim.runId, claim.requestIndex);
        if (!acquired) {
          throw new Error("Context preparation claim disappeared after reclamation");
        }
        return { status: "acquired", claim: acquired };
      }
      const winner = this.getContextPreparationClaim(claim.runId, claim.requestIndex);
      if (!winner) {
        throw new Error("Context preparation claim disappeared during reclamation");
      }
      return winner.requestHash === claim.requestHash
        ? { status: "in_progress", claim: winner }
        : { status: "conflict", claim: winner };
    });
    return tx();
  }

  renewContextPreparationClaim(claim: ContextPreparationClaimRelease, ttlMs: number): boolean {
    assertContextPreparationRequestKey(claim.runId, claim.requestIndex);
    if (
      !isSha256(claim.requestHash)
      || claim.ownerId.length === 0
      || !Number.isSafeInteger(claim.fencingToken)
      || claim.fencingToken < 1
      || !Number.isSafeInteger(ttlMs)
      || ttlMs <= 0
    ) {
      throw new Error("Context preparation claim renewal is invalid");
    }
    const renewedAt = this.contextPreparationNow();
    const expiresAt = renewedAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new Error("Context preparation claim expiry is invalid");
    }
    return this.db
      .query(
        `UPDATE runtime_context_preparation_claims
         SET expires_at = MAX(expires_at, ?)
         WHERE run_id = ? AND request_index = ? AND request_hash = ? AND owner_id = ?
           AND fencing_token = ? AND expires_at > ?`,
      )
      .run(
        expiresAt,
        claim.runId,
        claim.requestIndex,
        claim.requestHash,
        claim.ownerId,
        claim.fencingToken,
        renewedAt,
      ).changes > 0;
  }

  releaseContextPreparationClaim(claim: ContextPreparationClaimRelease): boolean {
    assertContextPreparationRequestKey(claim.runId, claim.requestIndex);
    if (
      !isSha256(claim.requestHash)
      || claim.ownerId.length === 0
      || !Number.isSafeInteger(claim.fencingToken)
      || claim.fencingToken < 1
    ) {
      throw new Error("Context preparation claim release is invalid");
    }
    return this.db
      .query(
        `DELETE FROM runtime_context_preparation_claims
         WHERE run_id = ? AND request_index = ? AND request_hash = ? AND owner_id = ?
           AND fencing_token = ?`,
      )
      .run(
        claim.runId,
        claim.requestIndex,
        claim.requestHash,
        claim.ownerId,
        claim.fencingToken,
      ).changes > 0;
  }

  listContextPlansByRun(runId: RunId): ContextPlan[] {
    return this.db
      .query<ContextPayloadRow, [string]>(
        `SELECT payload_json FROM runtime_context_plans
         WHERE run_id = ?
         ORDER BY request_index ASC, created_at ASC, id ASC`,
      )
      .all(runId)
      .map((row) => contextPlanSchema.parse(JSON.parse(row.payload_json)) as ContextPlan);
  }

  getLatestContextUsage(conversationId: ConversationId): ContextUsage | null {
    const row = this.db
      .query<ContextPayloadRow, [string]>(
        `SELECT payload_json FROM runtime_context_usage
         WHERE conversation_id = ?
         ORDER BY created_at DESC, request_index DESC, id DESC
         LIMIT 1`,
      )
      .get(conversationId);
    return row ? contextUsageSchema.parse(JSON.parse(row.payload_json)) as ContextUsage : null;
  }

  getContextUsageByRunRequest(runId: RunId, requestIndex: number): ContextUsage | null {
    const row = this.db
      .query<ContextPayloadRow, [string, number]>(
        `SELECT payload_json FROM runtime_context_usage
         WHERE run_id = ? AND request_index = ?
         LIMIT 1`,
      )
      .get(runId, requestIndex);
    return row ? contextUsageSchema.parse(JSON.parse(row.payload_json)) as ContextUsage : null;
  }

  listContextUsagesByRun(runId: RunId): ContextUsage[] {
    return this.db
      .query<ContextPayloadRow, [string]>(
        `SELECT payload_json FROM runtime_context_usage
         WHERE run_id = ?
         ORDER BY request_index ASC, created_at ASC, id ASC`,
      )
      .all(runId)
      .map((row) => contextUsageSchema.parse(JSON.parse(row.payload_json)) as ContextUsage);
  }

  commitContextCheckpoint(input: ContextCheckpointCommit): "committed" | "stale" {
    const checkpoint = contextCheckpointSchema.parse(input.checkpoint) as ContextCheckpoint;
    let committedEvent: Event | null = null;
    const tx = this.db.transaction((): "committed" | "stale" => {
      this.assertActiveContextPreparationClaim(input.preparationClaim);
      if (input.preparationClaim.runId !== checkpoint.sourceHeadRunId) {
        throw new ContextPreparationLeaseLostError(
          input.preparationClaim.runId,
          input.preparationClaim.requestIndex,
        );
      }
      const conversation = this.getConversation(checkpoint.conversationId);
      if (!conversation) {
        throw new Error(`Context checkpoint Conversation was not found: ${checkpoint.conversationId}`);
      }
      if (
        conversation.activeHeadRunId !== checkpoint.sourceHeadRunId
        || conversation.revision !== checkpoint.sourceConversationRevision
      ) {
        const reason = conversation.activeHeadRunId !== checkpoint.sourceHeadRunId
          ? "source_head_changed"
          : "source_revision_changed";
        this.insertContextDiagnostic({
          code: "CHECKPOINT_CAS_CONFLICT",
          conversationId: checkpoint.conversationId,
          checkpointId: checkpoint.id,
          runId: checkpoint.sourceHeadRunId,
          reason,
          details: {
            expectedHeadRunId: checkpoint.sourceHeadRunId,
            expectedRevision: checkpoint.sourceConversationRevision,
            actualHeadRunId: conversation.activeHeadRunId,
            actualRevision: conversation.revision,
            coverageThroughRunId: checkpoint.coverageThroughRunId,
            trigger: checkpoint.trigger,
          },
        });
        return "stale";
      }

      let lineage: Run[];
      try {
        lineage = this.listLineageRuns(
          checkpoint.conversationId,
          checkpoint.sourceHeadRunId,
        );
      } catch (error) {
        if (
          error instanceof RuntimeHistoryIntegrityError
          && error.conversationId === checkpoint.conversationId
        ) {
          this.insertContextDiagnostic({
            code: "CHECKPOINT_CAS_CONFLICT",
            conversationId: checkpoint.conversationId,
            checkpointId: checkpoint.id,
            runId: checkpoint.sourceHeadRunId,
            reason: "source_lineage_changed",
            details: {
              expectedHeadRunId: checkpoint.sourceHeadRunId,
              expectedRevision: checkpoint.sourceConversationRevision,
              coverageThroughRunId: checkpoint.coverageThroughRunId,
              trigger: checkpoint.trigger,
            },
          });
          return "stale";
        }
        throw error;
      }
      const coverageIndex = lineage.findIndex(
        (run) => run.id === checkpoint.coverageThroughRunId,
      );
      if (coverageIndex < 0) {
        throw new ContextCheckpointRejectedError(
          "coverage_not_active_ancestor",
          "Context checkpoint coverage is not an ancestor of the source head",
        );
      }
      const coverageRun = lineage[coverageIndex];
      if (
        !coverageRun
        || !["completed", "failed", "interrupted"].includes(coverageRun.status)
        || coverageRun.id === checkpoint.sourceHeadRunId
      ) {
        throw new ContextCheckpointRejectedError(
          "unsafe_coverage_boundary",
          "Context checkpoint coverage must end after a terminal non-current Run",
        );
      }
      const expectedHash = computeContextLineageHash(lineage, checkpoint.coverageThroughRunId);
      if (checkpoint.lineageHash !== expectedHash) {
        throw new ContextCheckpointRejectedError(
          "lineage_hash_mismatch",
          "Context checkpoint lineage hash does not match persisted history",
        );
      }

      let parentCheckpoint: ContextCheckpoint | undefined;
      if (checkpoint.parentCheckpointId) {
        const checkpointsById = new Map<string, ContextCheckpoint>();
        const parentRows = this.db
          .query<ContextCheckpointRow, []>(
            "SELECT * FROM runtime_context_checkpoints ORDER BY created_at ASC, id ASC",
          )
          .all();
        for (const row of parentRows) {
          if (this.invalidCheckpointIds.has(row.id)) continue;
          try {
            const parsed = contextCheckpointSchema.safeParse(JSON.parse(row.payload_json));
            if (parsed.success) {
              checkpointsById.set(parsed.data.id, parsed.data as ContextCheckpoint);
            }
          } catch {
            // An unreadable ancestor makes the complete parent chain unusable.
          }
        }
        if (!isContextCheckpointParentChainUsable(checkpoint, checkpointsById, lineage)) {
          throw new ContextCheckpointRejectedError(
            "dangling_parent",
            "Context checkpoint parent chain is not usable on the committed coverage lineage",
          );
        }
        parentCheckpoint = checkpointsById.get(checkpoint.parentCheckpointId);
      }

      const runs = this.listRunsByConversation(checkpoint.conversationId);
      const toolCalls = runs.flatMap((run) => this.listToolCallsByRun(run.id));
      const permissions = runs.flatMap((run) => this.listPermissionsByRun(run.id));
      const snapshot = {
        conversation,
        runs,
        messages: this.listTranscriptMessages(checkpoint.conversationId),
        toolCalls,
        permissions,
        checkpoints: [],
      };
      const safetyState = buildRuntimeSafetyState({
        conversationId: checkpoint.conversationId,
        activeRunIds: lineage.map((run) => run.id),
        toolCalls,
        permissions,
      });
      const sourceState = computeContextCoverageSourceState({
        snapshot,
        lineageRuns: lineage,
        coverageIndex,
        safetyStateHash: safetyState.hash,
        parentCheckpoint,
      });
      if (
        !sourceState.safe
        || checkpoint.safetyStateHash !== sourceState.safetyStateHash
        || checkpoint.sourceStateHash !== sourceState.sourceStateHash
      ) {
        this.insertContextDiagnostic({
          code: "CHECKPOINT_CAS_CONFLICT",
          conversationId: checkpoint.conversationId,
          checkpointId: checkpoint.id,
          runId: checkpoint.sourceHeadRunId,
          reason: "source_state_changed",
          details: {
            expectedHeadRunId: checkpoint.sourceHeadRunId,
            expectedRevision: checkpoint.sourceConversationRevision,
            coverageThroughRunId: checkpoint.coverageThroughRunId,
            trigger: checkpoint.trigger,
          },
        });
        return "stale";
      }

      this.db
        .query(
          `INSERT INTO runtime_context_checkpoints (
            id, conversation_id, coverage_through_run_id, source_head_run_id,
            source_conversation_revision, parent_checkpoint_id, format_version,
            compatibility_kind, compatibility_version, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpoint.id,
          checkpoint.conversationId,
          checkpoint.coverageThroughRunId,
          checkpoint.sourceHeadRunId,
          checkpoint.sourceConversationRevision,
          checkpoint.parentCheckpointId ?? null,
          checkpoint.formatVersion,
          checkpoint.compatibility.kind,
          checkpoint.compatibility.version,
          encode(checkpoint),
          checkpoint.time.created,
        );

      committedEvent = {
        id: input.eventId,
        type: "context.checkpoint.created",
        properties: {
          checkpointId: checkpoint.id,
          conversationId: checkpoint.conversationId,
          sourceHeadRunId: checkpoint.sourceHeadRunId,
          sourceConversationRevision: checkpoint.sourceConversationRevision,
          coverageThroughRunId: checkpoint.coverageThroughRunId,
          ...(checkpoint.parentCheckpointId
            ? { parentCheckpointId: checkpoint.parentCheckpointId }
            : {}),
          trigger: checkpoint.trigger,
          formatVersion: checkpoint.formatVersion,
          compatibility: checkpoint.compatibility,
          budget: {
            contextWindow: checkpoint.budget.contextWindow,
            estimatedInputTokens: checkpoint.budget.estimatedInputTokens,
            rawHistoryTokens: checkpoint.budget.rawHistoryTokens,
            checkpointTokens: checkpoint.budget.checkpointTokens,
            safetyStateTokens: checkpoint.budget.safetyStateTokens,
            reservedOutputTokens: checkpoint.budget.reservedOutputTokens,
          },
        },
        time: checkpoint.time.created,
      };
      this.insertEvent(committedEvent);
      return "committed";
    });

    let result: "committed" | "stale";
    try {
      result = tx();
    } catch (error) {
      if (error instanceof ContextCheckpointRejectedError) {
        this.insertContextDiagnostic({
          code: "CHECKPOINT_REJECTED",
          conversationId: checkpoint.conversationId,
          checkpointId: checkpoint.id,
          runId: checkpoint.sourceHeadRunId,
          reason: error.reason,
          details: {
            sourceHeadRunId: checkpoint.sourceHeadRunId,
            sourceConversationRevision: checkpoint.sourceConversationRevision,
            coverageThroughRunId: checkpoint.coverageThroughRunId,
            trigger: checkpoint.trigger,
          },
        });
      }
      throw error;
    }
    if (result === "committed" && committedEvent) {
      this.options.eventBus?.publish(runtimeEventToEnvelope(committedEvent));
    }
    return result;
  }

  saveContextPlan(input: ContextPlanCommit): void {
    const parsed = contextPlanSchema.parse(input.plan) as ContextPlan;
    let committedEvent: Event | null = null;
    const tx = this.db.transaction((): void => {
      this.assertActiveContextPreparationClaim(input.preparationClaim);
      if (
        input.preparationClaim.runId !== parsed.runId
        || input.preparationClaim.requestIndex !== parsed.requestIndex
        || input.preparationClaim.requestHash !== parsed.requestHash
      ) {
        throw new ContextPreparationLeaseLostError(parsed.runId, parsed.requestIndex);
      }
      this.validateContextPlan(parsed);
      this.db
        .query(
          `INSERT INTO runtime_context_plans (
            id, conversation_id, run_id, request_index, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          parsed.id,
          parsed.conversationId,
          parsed.runId,
          parsed.requestIndex,
          encode(parsed),
          parsed.time.created,
        );
      committedEvent = {
        id: input.eventId,
        type: "context.plan.created",
        properties: {
          planId: parsed.id,
          conversationId: parsed.conversationId,
          runId: parsed.runId,
          requestIndex: parsed.requestIndex,
          sourceHeadRunId: parsed.sourceHeadRunId,
          sourceConversationRevision: parsed.sourceConversationRevision,
          view: parsed.view,
          ...(parsed.checkpointId ? { checkpointId: parsed.checkpointId } : {}),
          reason: parsed.reason,
          ...(parsed.checkpointRejections?.length
            ? { checkpointRejections: parsed.checkpointRejections }
            : {}),
          trigger: parsed.trigger,
          budget: {
            contextWindow: parsed.budget.contextWindow,
            estimatedInputTokens: parsed.budget.estimatedInputTokens,
            rawHistoryTokens: parsed.budget.rawHistoryTokens,
            checkpointTokens: parsed.budget.checkpointTokens,
            safetyStateTokens: parsed.budget.safetyStateTokens,
            reservedOutputTokens: parsed.budget.reservedOutputTokens,
          },
        },
        time: parsed.time.created,
      };
      this.insertEvent(committedEvent);
    });
    tx();
    if (committedEvent) {
      this.options.eventBus?.publish(runtimeEventToEnvelope(committedEvent));
    }
  }

  private assertActiveContextPreparationClaim(claim: ContextPreparationClaim): void {
    assertContextPreparationClaim(claim);
    const active = this.db
      .query<{ active: number }, [string, number, string, string, number, number]>(
        `SELECT 1 AS active
         FROM runtime_context_preparation_claims
         WHERE run_id = ? AND request_index = ? AND request_hash = ? AND owner_id = ?
           AND fencing_token = ? AND expires_at > ?`,
      )
      .get(
        claim.runId,
        claim.requestIndex,
        claim.requestHash,
        claim.ownerId,
        claim.fencingToken,
        this.contextPreparationNow(),
      );
    if (!active) {
      throw new ContextPreparationLeaseLostError(claim.runId, claim.requestIndex);
    }
  }

  private contextPreparationNow(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("Context preparation clock is invalid");
    }
    return now;
  }

  saveContextUsage(usage: ContextUsage): void {
    const parsed = contextUsageSchema.parse(usage) as ContextUsage;
    this.requireContextRunOwnership(
      parsed.conversationId,
      parsed.runId,
      "usage",
    );
    if (parsed.view === "checkpoint") {
      if (!parsed.checkpointId) {
        throw new Error("Context usage checkpoint view requires a checkpoint");
      }
      this.requireContextCheckpointOwnership(
        parsed.conversationId,
        parsed.checkpointId,
        "usage",
      );
    } else if (parsed.checkpointId) {
      throw new Error("Context usage raw view cannot reference a checkpoint");
    }
    this.db
      .query(
        `INSERT INTO runtime_context_usage (
          id, conversation_id, run_id, request_index, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.conversationId,
        parsed.runId,
        parsed.requestIndex,
        encode(parsed),
        parsed.time.created,
      );
  }

  updateContextUsageProviderObservation(input: {
    runId: RunId;
    requestIndex: number;
    providerObservation: NonNullable<ContextUsage["providerObservation"]>;
  }): ContextUsage {
    const current = this.getContextUsageByRunRequest(input.runId, input.requestIndex);
    if (!current) {
      throw new Error(
        `Context usage estimate was not found: ${input.runId}/${input.requestIndex}`,
      );
    }
    if (current.providerObservation) {
      if (
        JSON.stringify(current.providerObservation)
        !== JSON.stringify(input.providerObservation)
      ) {
        throw new Error("Context usage Provider observation is immutable");
      }
      return current;
    }
    const updated = contextUsageSchema.parse({
      ...current,
      providerObservation: input.providerObservation,
    }) as ContextUsage;
    const result = this.db
      .query(
        `UPDATE runtime_context_usage
         SET payload_json = ?
         WHERE run_id = ? AND request_index = ?
           AND json_extract(payload_json, '$.providerObservation') IS NULL`,
      )
      .run(encode(updated), input.runId, input.requestIndex);
    if (result.changes === 0) {
      const raced = this.getContextUsageByRunRequest(input.runId, input.requestIndex);
      if (
        raced?.providerObservation
        && JSON.stringify(raced.providerObservation)
          === JSON.stringify(input.providerObservation)
      ) {
        return raced;
      }
      throw new Error("Context usage Provider observation is immutable");
    }
    return updated;
  }

  updateContextUsageNextTurnForecast(input: {
    runId: RunId;
    requestIndex: number;
    nextTurnForecast: NonNullable<ContextUsage["nextTurnForecast"]>;
  }): ContextUsage {
    const current = this.getContextUsageByRunRequest(input.runId, input.requestIndex);
    if (!current) {
      throw new Error(
        `Context usage estimate was not found: ${input.runId}/${input.requestIndex}`,
      );
    }
    if (current.nextTurnForecast) {
      if (
        JSON.stringify(current.nextTurnForecast)
        !== JSON.stringify(input.nextTurnForecast)
      ) {
        throw new Error("Next-turn context forecast is immutable");
      }
      return current;
    }
    const updated = contextUsageSchema.parse({
      ...current,
      nextTurnForecast: input.nextTurnForecast,
    }) as ContextUsage;
    const result = this.db
      .query(
        `UPDATE runtime_context_usage
         SET payload_json = ?
         WHERE run_id = ? AND request_index = ?
           AND json_extract(payload_json, '$.nextTurnForecast') IS NULL`,
      )
      .run(encode(updated), input.runId, input.requestIndex);
    if (result.changes === 0) {
      const raced = this.getContextUsageByRunRequest(input.runId, input.requestIndex);
      if (
        raced?.nextTurnForecast
        && JSON.stringify(raced.nextTurnForecast)
          === JSON.stringify(input.nextTurnForecast)
      ) {
        return raced;
      }
      throw new Error("Next-turn context forecast is immutable");
    }
    return updated;
  }

  private validateContextPlan(plan: ContextPlan): void {
    const conversation = this.getConversation(plan.conversationId);
    if (!conversation) {
      throw new Error(`Context plan Conversation was not found: ${plan.conversationId}`);
    }
    this.requireContextRunOwnership(plan.conversationId, plan.runId, "plan");
    this.requireContextRunOwnership(
      plan.conversationId,
      plan.sourceHeadRunId,
      "plan source head",
    );
    if (conversation.activeHeadRunId !== plan.runId) {
      throw new Error("Context plan Run is not the active head");
    }
    if (plan.sourceHeadRunId !== plan.runId) {
      throw new Error("Context plan source head does not match its active Run");
    }
    if (conversation.revision !== plan.sourceConversationRevision) {
      throw new Error("Context plan source revision is stale");
    }
    if (plan.safetyState.conversationId !== plan.conversationId) {
      throw new Error("Context plan Safety State does not belong to its Conversation");
    }

    const lineageRunIds = this.listLineageRuns(
      plan.conversationId,
      plan.sourceHeadRunId,
    ).map((run) => run.id);
    if (!sameRuntimeIds(plan.lineageRunIds, lineageRunIds)) {
      throw new Error("Context plan lineage does not match the persisted active lineage");
    }

    let expectedRawRunIds: RunId[];
    if (plan.view === "checkpoint") {
      if (plan.reason !== "checkpoint_selected" || !plan.checkpointId) {
        throw new Error("Context plan checkpoint view is inconsistent");
      }
      const checkpoint = this.requireContextCheckpointOwnership(
        plan.conversationId,
        plan.checkpointId,
        "plan",
      );
      const coverageIndex = lineageRunIds.indexOf(checkpoint.coverageThroughRunId);
      if (coverageIndex < 0) {
        throw new Error("Context plan checkpoint coverage is not on the active lineage");
      }
      expectedRawRunIds = lineageRunIds.slice(coverageIndex + 1);
    } else {
      if (plan.reason === "checkpoint_selected" || plan.checkpointId) {
        throw new Error("Context plan raw view cannot select a checkpoint");
      }
      expectedRawRunIds = lineageRunIds;
    }
    if (!sameRuntimeIds(plan.rawRunIds, expectedRawRunIds)) {
      throw new Error("Context plan raw Run tail does not match its selected view");
    }

    const expectedRawRange = expectedRawRunIds.length === 0
      ? undefined
      : {
          fromRunId: expectedRawRunIds[0]!,
          throughRunId: expectedRawRunIds.at(-1)!,
        };
    if (
      plan.rawRange?.fromRunId !== expectedRawRange?.fromRunId
      || plan.rawRange?.throughRunId !== expectedRawRange?.throughRunId
    ) {
      throw new Error("Context plan raw range does not match its raw Run tail");
    }

    if (plan.reason === "compaction_required") {
      const coverageIndex = plan.eligibleCoverageThroughRunId
        ? lineageRunIds.indexOf(plan.eligibleCoverageThroughRunId)
        : -1;
      if (coverageIndex < 0 || coverageIndex >= lineageRunIds.length - 1) {
        throw new Error("Context plan eligible coverage is not a non-current ancestor");
      }
    } else if (plan.eligibleCoverageThroughRunId) {
      throw new Error("Context plan has unexpected eligible coverage");
    }
  }

  private requireContextRunOwnership(
    conversationId: ConversationId,
    runId: RunId,
    record: string,
  ): Run {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Context ${record} Run was not found: ${runId}`);
    }
    if (run.conversationId !== conversationId) {
      throw new Error(
        `Context ${record} Run ${runId} does not belong to Conversation ${conversationId}`,
      );
    }
    return run;
  }

  private requireContextCheckpointOwnership(
    conversationId: ConversationId,
    checkpointId: ContextCheckpoint["id"],
    record: string,
  ): ContextCheckpoint {
    const row = this.db
      .query<ContextPayloadRow, [string]>(
        "SELECT payload_json FROM runtime_context_checkpoints WHERE id = ?",
      )
      .get(checkpointId);
    if (!row) {
      throw new Error(`Context ${record} checkpoint was not found: ${checkpointId}`);
    }
    const checkpoint = contextCheckpointSchema.parse(
      JSON.parse(row.payload_json),
    ) as ContextCheckpoint;
    if (checkpoint.conversationId !== conversationId) {
      throw new Error(
        `Context ${record} checkpoint ${checkpointId} does not belong to Conversation ${conversationId}`,
      );
    }
    return checkpoint;
  }

  listParts(messageId: MessageId): Part[] {
    return this.db
      .query<PartRow, [string]>(
        "SELECT payload_json FROM runtime_message_parts WHERE message_id = ? ORDER BY sort_index",
      )
      .all(messageId)
      .map((row) => partSchema.parse(JSON.parse(row.payload_json)) as Part);
  }

  saveToolCall(toolCall: ToolCall): void {
    const authorization = toolCall.authorization
      ? toolCallAuthorizationSnapshotSchema.parse(toolCall.authorization)
      : undefined;
    this.db
      .query(
        `INSERT INTO runtime_tool_calls (
          id, conversation_id, run_id, message_id, part_id, tool_name, state,
          input_json, permission_id, result_json, error_json, time_json, metadata_json,
          authorization_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          part_id = excluded.part_id,
          state = excluded.state,
          input_json = excluded.input_json,
          permission_id = excluded.permission_id,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          time_json = excluded.time_json,
          metadata_json = excluded.metadata_json,
          authorization_json = COALESCE(
            runtime_tool_calls.authorization_json,
            excluded.authorization_json
          )`,
      )
      .run(
        toolCall.id,
        toolCall.conversationId,
        toolCall.runId,
        toolCall.messageId,
        toolCall.partId ?? null,
        toolCall.toolName,
        toolCall.state,
        encode(toolCall.input),
        toolCall.permissionId ?? null,
        toolCall.result ? encode(toolCall.result) : null,
        toolCall.error ? encode(toolCall.error) : null,
        encode(toolCall.time),
        toolCall.metadata ? encode(toolCall.metadata) : null,
        authorization ? encode(authorization) : null,
      );
  }

  getToolCall(id: ToolCallId): ToolCall | null {
    const row = this.db
      .query<ToolCallRow, [string]>("SELECT * FROM runtime_tool_calls WHERE id = ?")
      .get(id);

    if (!row) {
      return null;
    }

    return toolCallFromRow(row);
  }

  listToolCallsByRun(runId: RunId): ToolCall[] {
    return this.db
      .query<ToolCallRow, [string]>(
        `SELECT * FROM runtime_tool_calls
        WHERE run_id = ?
        ORDER BY
          json_extract(time_json, '$.created') ASC,
          id ASC`,
      )
      .all(runId)
      .map(toolCallFromRow);
  }

  savePermission(permission: Permission): void {
    const parsed = permissionSchema.parse(permission) as Permission;

    this.db
      .query(
        `INSERT INTO runtime_permissions (
          id, conversation_id, run_id, message_id, tool_call_id, status,
          tool_id, title, input_summary, risk_json, confirmation_json,
          presentation_json, adapter_json, decision_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          adapter_json = excluded.adapter_json,
          decision_json = excluded.decision_json`,
      )
      .run(
        parsed.id,
        parsed.conversationId,
        parsed.runId,
        parsed.messageId,
        parsed.toolCallId,
        parsed.status,
        parsed.toolId,
        parsed.title,
        parsed.inputSummary ?? null,
        encode(parsed.risk),
        encode(parsed.confirmation),
        parsed.presentation ? encode(parsed.presentation) : null,
        parsed.adapter ? encode(parsed.adapter) : null,
        parsed.decision ? encode(parsed.decision) : null,
        parsed.createdAt,
      );
  }

  getPermission(id: PermissionId): Permission | null {
    const row = this.db
      .query<PermissionRow, [string]>("SELECT * FROM runtime_permissions WHERE id = ?")
      .get(id);

    if (!row) {
      return null;
    }

    return permissionSchema.parse({
      id: row.id,
      conversationId: row.conversation_id,
      runId: row.run_id,
      messageId: row.message_id,
      toolCallId: row.tool_call_id,
      status: row.status,
      toolId: row.tool_id,
      title: row.title,
      inputSummary: row.input_summary ?? undefined,
      risk: decode(row.risk_json),
      confirmation: decode(row.confirmation_json),
      presentation: decode(row.presentation_json),
      adapter: decode(row.adapter_json),
      decision: decode(row.decision_json),
      createdAt: row.created_at,
    }) as Permission;
  }

  getPermissionByToolCallId(toolCallId: ToolCallId): Permission | null {
    const row = this.db
      .query<PermissionRow, [string]>(
        "SELECT * FROM runtime_permissions WHERE tool_call_id = ?",
      )
      .get(toolCallId);
    return row ? permissionFromRow(row) : null;
  }

  getPermissionByAiSdkApprovalId(approvalId: string): Permission | null {
    const row = this.db
      .query<PermissionRow, [string]>(
        `SELECT * FROM runtime_permissions
        WHERE json_extract(adapter_json, '$.aiSdkApprovalId') = ?
        LIMIT 1`,
      )
      .get(approvalId);
    return row ? permissionFromRow(row) : null;
  }

  listPermissionsByRun(runId: RunId): Permission[] {
    return this.db
      .query<PermissionRow, [string]>(
        `SELECT * FROM runtime_permissions
        WHERE run_id = ?
        ORDER BY created_at ASC, id ASC`,
      )
      .all(runId)
      .map(permissionFromRow);
  }

  listPendingPermissionsByRun(runId: RunId): Permission[] {
    return this.db
      .query<PermissionRow, [string]>(
        `SELECT * FROM runtime_permissions
        WHERE run_id = ? AND status = 'pending'
        ORDER BY created_at ASC, id ASC`,
      )
      .all(runId)
      .map(permissionFromRow);
  }

  bindPermissionAiSdkApproval(input: {
    permissionId: PermissionId;
    toolCallId: ToolCallId;
    aiSdkApprovalId: string;
    aiSdkToolCallId: string;
    boundAt: number;
    eventId: Event["id"];
  }): Permission {
    let bound: Permission | null = null;
    let event: Event | null = null;
    const tx = this.db.transaction(() => {
      const current = this.getPermission(input.permissionId);
      if (
        !current ||
        current.toolCallId !== input.toolCallId ||
        current.status !== "pending"
      ) {
        throw new Error("Pending Tool Permission was not found for this ToolCall");
      }
      if (
        current.adapter?.aiSdkApprovalId &&
        current.adapter.aiSdkApprovalId !== input.aiSdkApprovalId
      ) {
        throw new Error("Tool Permission is already bound to another AI SDK approval");
      }
      if (
        current.adapter?.aiSdkToolCallId &&
        current.adapter.aiSdkToolCallId !== input.aiSdkToolCallId
      ) {
        throw new Error("Tool Permission is already bound to another AI SDK ToolCall");
      }

      const updated: Permission = {
        ...current,
        adapter: {
          aiSdkApprovalId: input.aiSdkApprovalId,
          aiSdkToolCallId: input.aiSdkToolCallId,
        },
      };
      const updatedEvent: Event = {
        id: input.eventId,
        type: "permission.updated",
        properties: { info: updated },
        time: input.boundAt,
      };
      this.savePermission(updated);
      this.insertEvent(updatedEvent);
      bound = updated;
      event = updatedEvent;
    });

    tx();
    if (!bound || !event) {
      throw new Error("AI SDK approval binding transaction did not commit");
    }
    this.options.eventBus?.publish(runtimeEventToEnvelope(event));
    return bound;
  }

  commitPermissionContinuation(
    input: RuntimePermissionContinuationCommit,
  ): {
    conversation: Conversation;
    run: Run;
    permissions: Permission[];
  } {
    let committedConversation: Conversation | null = null;
    let committedRun: Run | null = null;
    let committedPermissions: Permission[] = [];
    let committedEvents: Event[] = [];
    const tx = this.db.transaction(() => {
      const run = this.getRun(input.runId);
      if (!run || run.status !== "waiting_for_permission") {
        throw new Error("Runtime Run is not waiting for permission");
      }
      const conversation = this.getConversation(run.conversationId);
      if (
        !conversation ||
        conversation.status.type !== "waiting_for_permission" ||
        conversation.status.runId !== run.id
      ) {
        throw new Error("Conversation is not waiting for this Runtime Run");
      }

      const pending = this.listPendingPermissionsByRun(run.id);
      const responseById = new Map(
        input.responses.map((response) => [response.permissionId, response]),
      );
      if (
        pending.length === 0 ||
        responseById.size !== input.responses.length ||
        pending.length !== responseById.size ||
        pending.some((permission) => !responseById.has(permission.id)) ||
        input.eventIds.permissions.length !== pending.length ||
        input.eventIds.tools.length !== pending.length
      ) {
        throw new Error("Permission responses must cover every pending Permission exactly once");
      }

      const events: Event[] = [];
      const resolvedPermissions = pending.map((permission, index) => {
        const response = responseById.get(permission.id)!;
        if (
          response.approved &&
          permission.confirmation.level === "strong" &&
          response.confirmationText !== permission.confirmation.prompt
        ) {
          throw new Error(
            "Critical Permission requires an exact strong confirmation",
          );
        }
        const updated: Permission = {
          ...permission,
          status: response.approved ? "approved" : "denied",
          decision: {
            source: "user",
            ...(response.reason ? { reason: response.reason } : {}),
            ...(response.approved &&
              permission.confirmation.level === "strong"
              ? { confirmationVerified: true }
              : {}),
            decidedAt: input.continuedAt,
          },
        };
        this.savePermission(updated);
        events.push({
          id: input.eventIds.permissions[index]!,
          type: "permission.resolved",
          properties: { info: updated },
          time: input.continuedAt,
        });

        if (!response.approved) {
          const toolCall = this.getToolCall(permission.toolCallId);
          if (!toolCall || toolCall.state !== "waiting_for_permission") {
            throw new Error("Denied Permission does not own a waiting ToolCall");
          }
          const deniedToolCall: ToolCall = {
            ...toolCall,
            state: "error",
            result: {
              ok: false,
              error: {
                code: "TOOL_PERMISSION_DENIED",
                message: response.reason ?? "User denied this tool call.",
                retryable: false,
                outcome: "not_started",
              },
            },
            error: {
              code: "TOOL_PERMISSION_DENIED",
              message: response.reason ?? "User denied this tool call.",
              retryable: false,
              outcome: "not_started",
            },
            time: {
              ...toolCall.time,
              completed: input.continuedAt,
            },
          };
          this.saveToolCall(deniedToolCall);
          const toolEventId = input.eventIds.tools[index];
          if (!toolEventId) {
            throw new Error("Missing Tool event id for denied Permission");
          }
          events.push({
            id: toolEventId,
            type: "tool.updated",
            properties: { info: deniedToolCall },
            time: input.continuedAt,
          });
        }

        return updated;
      });

      const updatedRun: Run = {
        ...run,
        status: "running",
      };
      const updatedConversation: Conversation = {
        ...conversation,
        status: { type: "busy", runId: run.id },
        time: { ...conversation.time, updated: input.continuedAt },
      };
      events.push(
        {
          id: input.eventIds.run,
          type: "run.updated",
          properties: { info: updatedRun },
          time: input.continuedAt,
        },
        {
          id: input.eventIds.conversation,
          type: "conversation.status",
          properties: {
            conversationId: updatedConversation.id,
            status: updatedConversation.status,
          },
          time: input.continuedAt,
        },
      );
      this.saveRun(updatedRun);
      this.saveConversation(updatedConversation);
      events.forEach((runtimeEvent) => this.insertEvent(runtimeEvent));
      committedConversation = updatedConversation;
      committedRun = updatedRun;
      committedPermissions = resolvedPermissions;
      committedEvents = events;
    });

    tx();
    committedEvents.forEach((event) =>
      this.options.eventBus?.publish(runtimeEventToEnvelope(event))
    );
    if (!committedConversation || !committedRun) {
      throw new Error("Permission continuation transaction did not commit");
    }
    return {
      conversation: committedConversation,
      run: committedRun,
      permissions: committedPermissions,
    };
  }

  commitToolPermissionRequest(
    input: RuntimeToolPermissionRequestCommit,
  ): { conversation: Conversation; run: Run } {
    const permission = permissionSchema.parse(input.permission) as Permission;
    if (
      permission.status !== "pending" ||
      permission.toolCallId !== input.toolCall.id ||
      permission.conversationId !== input.toolCall.conversationId ||
      permission.runId !== input.toolCall.runId ||
      permission.messageId !== input.toolCall.messageId ||
      input.toolCall.state !== "waiting_for_permission" ||
      input.toolCall.permissionId !== permission.id
    ) {
      throw new Error("Invalid Tool Permission request commit");
    }

    let committedConversation: Conversation | null = null;
    let committedRun: Run | null = null;
    let committedEvents: Event[] = [];
    const tx = this.db.transaction(() => {
      const conversation = this.getConversation(permission.conversationId);
      const run = this.getRun(permission.runId);
      if (!conversation || !run || run.conversationId !== conversation.id) {
        throw new Error("Tool Permission target Run or Conversation was not found");
      }
      if (
        !["running", "waiting_for_tool", "waiting_for_permission"].includes(run.status)
      ) {
        throw new Error("Tool Permission cannot be requested for a terminal Run");
      }
      if (
        conversation.status.type !== "busy" &&
        conversation.status.type !== "waiting_for_permission"
      ) {
        throw new Error("Tool Permission cannot be requested for an inactive Conversation");
      }
      if (
        "runId" in conversation.status &&
        conversation.status.runId !== run.id
      ) {
        throw new Error("Conversation is active for a different Run");
      }

      const updatedRun: Run = {
        ...run,
        status: "waiting_for_permission",
      };
      const updatedConversation: Conversation = {
        ...conversation,
        status: {
          type: "waiting_for_permission",
          runId: run.id,
          permissionId: permission.id,
        },
        time: {
          ...conversation.time,
          updated: input.requestedAt,
        },
      };
      const events: Event[] = [
        {
          id: input.eventIds.tool,
          type: "tool.updated",
          properties: { info: input.toolCall },
          time: input.requestedAt,
        },
        {
          id: input.eventIds.permission,
          type: "permission.requested",
          properties: { info: permission },
          time: input.requestedAt,
        },
        {
          id: input.eventIds.run,
          type: "run.updated",
          properties: { info: updatedRun },
          time: input.requestedAt,
        },
        {
          id: input.eventIds.conversation,
          type: "conversation.status",
          properties: {
            conversationId: updatedConversation.id,
            status: updatedConversation.status,
          },
          time: input.requestedAt,
        },
      ];

      this.saveToolCall(input.toolCall);
      this.savePermission(permission);
      this.saveRun(updatedRun);
      this.saveConversation(updatedConversation);
      events.forEach((event) => this.insertEvent(event));
      committedConversation = updatedConversation;
      committedRun = updatedRun;
      committedEvents = events;
    });

    tx();
    committedEvents.forEach((event) =>
      this.options.eventBus?.publish(runtimeEventToEnvelope(event))
    );
    if (!committedConversation || !committedRun) {
      throw new Error("Tool Permission request transaction did not commit");
    }
    return {
      conversation: committedConversation,
      run: committedRun,
    };
  }

  resolvePermission(input: {
    permissionId: PermissionId;
    runId: RunId;
    status: "approved" | "denied" | "cancelled";
    source: "user" | "system";
    reason?: string;
    decidedAt: number;
    eventId: Event["id"];
  }): Permission {
    let resolved: Permission | null = null;
    let event: Event | null = null;
    const tx = this.db.transaction(() => {
      const current = this.getPermission(input.permissionId);
      if (!current || current.runId !== input.runId) {
        throw new Error("Tool Permission was not found for this Run");
      }
      if (current.status !== "pending") {
        throw new Error("Tool Permission is no longer pending");
      }

      const updated: Permission = {
        ...current,
        status: input.status,
        decision: {
          source: input.source,
          ...(input.reason ? { reason: input.reason } : {}),
          decidedAt: input.decidedAt,
        },
      };
      const resolvedEvent: Event = {
        id: input.eventId,
        type: "permission.resolved",
        properties: { info: updated },
        time: input.decidedAt,
      };
      this.savePermission(updated);
      this.insertEvent(resolvedEvent);
      resolved = updated;
      event = resolvedEvent;
    });

    tx();
    if (!resolved || !event) {
      throw new Error("Tool Permission resolution transaction did not commit");
    }
    this.options.eventBus?.publish(runtimeEventToEnvelope(event));
    return resolved;
  }

  appendEvent(event: Event): void {
    const parsed = eventSchema.parse(event) as Event;

    this.insertEvent(parsed);

    this.options.eventBus?.publish(runtimeEventToEnvelope(parsed));
  }

  private insertEvent(event: Event): void {
    this.db
      .query(
        `INSERT INTO runtime_events (id, type, conversation_id, run_id, payload_json, time)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        extractConversationId(event.properties),
        extractRunId(event.properties),
        encode(event),
        event.time,
      );
  }

  private removeMessageTail(
    conversationId: ConversationId,
    removedMessageIds: readonly MessageId[],
  ): void {
    const placeholders = removedMessageIds.map(() => "?").join(", ");
    const attachmentIds = this.db
      .query<{ attachment_id: string }, string[]>(
        `SELECT DISTINCT attachment_id
         FROM runtime_message_attachments
         WHERE message_id IN (${placeholders})`,
      )
      .all(...removedMessageIds)
      .map((row) => row.attachment_id);
    const runFilter = `
      conversation_id = ?
      AND (
        parent_message_id IN (${placeholders})
        OR assistant_message_id IN (${placeholders})
      )`;
    const runFilterParams = [conversationId, ...removedMessageIds, ...removedMessageIds];

    this.db
      .query(
        `DELETE FROM runtime_events
        WHERE run_id IN (SELECT id FROM runtime_runs WHERE ${runFilter})`,
      )
      .run(...runFilterParams);
    this.db
      .query(
        `DELETE FROM runtime_traces
        WHERE run_id IN (SELECT id FROM runtime_runs WHERE ${runFilter})`,
      )
      .run(...runFilterParams);
    this.db
      .query(`DELETE FROM runtime_runs WHERE ${runFilter}`)
      .run(...runFilterParams);
    this.db
      .query(
        `DELETE FROM runtime_messages
        WHERE conversation_id = ? AND id IN (${placeholders})`,
      )
      .run(conversationId, ...removedMessageIds);
    this.scheduleUnreferencedAttachments(attachmentIds);
  }

  private assertFilePartAttachment(part: FilePart): void {
    const row = this.db
      .query<{
        filename: string;
        media_type: string;
        byte_length: number;
        attachment_state: string;
        blob_state: string;
      }, [string]>(
        `SELECT
          attachment.filename,
          attachment.media_type,
          attachment.byte_length,
          attachment.state AS attachment_state,
          blob.state AS blob_state
         FROM runtime_attachments AS attachment
         JOIN runtime_blobs AS blob ON blob.id = attachment.blob_id
         WHERE attachment.id = ?`,
      )
      .get(part.attachmentId);
    if (!row) {
      throw new RuntimeAttachmentError("ATTACHMENT_NOT_FOUND", "附件不存在。", 404);
    }
    if (row.attachment_state !== "ready" || row.blob_state !== "available") {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_CONTENT_MISSING",
        "附件内容不存在或暂不可用。",
        422,
      );
    }
    if (
      row.filename !== part.filename ||
      row.media_type !== part.mediaType ||
      row.byte_length !== part.byteLength
    ) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_CORRUPT",
        "消息中的附件快照与附件索引不一致。",
        500,
        { attachment_id: part.attachmentId, mark_corrupt: true },
      );
    }
  }

  private assertLoadedFilePartSnapshot(part: FilePart): void {
    const row = this.db
      .query<{
        filename: string;
        media_type: string;
        byte_length: number;
      }, [string]>(
        `SELECT filename, media_type, byte_length
         FROM runtime_attachments
         WHERE id = ?`,
      )
      .get(part.attachmentId);
    if (
      !row ||
      row.filename !== part.filename ||
      row.media_type !== part.mediaType ||
      row.byte_length !== part.byteLength
    ) {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_CORRUPT",
        "消息中的附件快照与附件索引不一致。",
        500,
        { attachment_id: part.attachmentId, mark_corrupt: true },
      );
    }
  }

  private parseAndAssertLoadedMessage(messageJson: string): Message {
    let message: Message;
    try {
      message = messageSchema.parse(JSON.parse(messageJson)) as Message;
      this.assertLoadedMessageAttachmentIntegrity(message);
      return message;
    } catch (error) {
      this.persistAttachmentCorruption(error);
      throw error;
    }
  }

  private assertLoadedMessageAttachmentIntegrity(message: Message): void {
    const storedRows = this.db
      .query<MessageFilePartRow, [string]>(
        `SELECT
           part.id,
           part.message_id,
           part.type,
           part.sort_index,
           part.payload_json,
           relation.attachment_id AS indexed_attachment_id,
           relation.message_id AS indexed_message_id,
           relation.sort_index AS indexed_sort_index
         FROM runtime_message_parts AS part
         LEFT JOIN runtime_message_attachments AS relation ON relation.part_id = part.id
         WHERE part.message_id = ? AND (part.type = 'file' OR relation.part_id IS NOT NULL)
         ORDER BY part.sort_index ASC, part.id ASC`,
      )
      .all(message.id);
    const messageParts = message.parts
      .map((part, sortIndex) => ({ part, sortIndex }))
      .filter((entry): entry is { part: FilePart; sortIndex: number } => entry.part.type === "file");
    const recognizedIds = new Set<string>([
      ...messageParts.map(({ part }) => part.attachmentId),
      ...storedRows
        .map((row) => row.indexed_attachment_id)
        .filter((id): id is string => Boolean(id)),
    ]);

    const fail = (): never => {
      throw new RuntimeAttachmentError(
        "ATTACHMENT_CORRUPT",
        "消息中的附件快照、Part 与附件索引不一致。",
        500,
        { attachment_ids: [...recognizedIds], mark_corrupt: true },
      );
    };

    if (storedRows.length !== messageParts.length) fail();
    const storedById = new Map(storedRows.map((row) => [row.id, row]));
    for (const { part, sortIndex } of messageParts) {
      const row = storedById.get(part.id);
      if (!row) return fail();
      const storedPart = (() => {
        try {
          return partSchema.parse(JSON.parse(row.payload_json)) as Part;
        } catch {
          return fail();
        }
      })();
      if (
        storedPart.type !== "file" ||
        row.message_id !== message.id ||
        row.sort_index !== sortIndex ||
        row.indexed_attachment_id !== part.attachmentId ||
        row.indexed_message_id !== message.id ||
        row.indexed_sort_index !== sortIndex ||
        storedPart.id !== part.id ||
        storedPart.messageId !== part.messageId ||
        storedPart.conversationId !== part.conversationId ||
        storedPart.attachmentId !== part.attachmentId ||
        storedPart.filename !== part.filename ||
        storedPart.mediaType !== part.mediaType ||
        storedPart.byteLength !== part.byteLength
      ) {
        if (storedPart.type === "file") recognizedIds.add(storedPart.attachmentId);
        fail();
      }
      this.assertLoadedFilePartSnapshot(part);
    }
  }

  private persistAttachmentCorruption(error: unknown): void {
    if (
      !(error instanceof RuntimeAttachmentError) ||
      error.code !== "ATTACHMENT_CORRUPT" ||
      error.data?.mark_corrupt !== true ||
      typeof error.data.attachment_id !== "string" &&
      !Array.isArray(error.data.attachment_ids)
    ) {
      return;
    }
    const ids = new Set<string>();
    if (typeof error.data.attachment_id === "string") ids.add(error.data.attachment_id);
    if (Array.isArray(error.data.attachment_ids)) {
      for (const id of error.data.attachment_ids) {
        if (typeof id === "string") ids.add(id);
      }
    }
    for (const id of ids) {
      this.db
        .query("UPDATE runtime_attachments SET state = 'corrupt', updated_at = ? WHERE id = ?")
        .run(Date.now(), id);
    }
  }

  private scheduleUnreferencedAttachments(ids: readonly string[]): void {
    const gcAfter = Date.now() + ATTACHMENT_LIMITS.gcGraceMs;
    for (const id of new Set(ids)) {
      this.db
        .query(
          `UPDATE runtime_attachments
           SET gc_after = ?, updated_at = ?
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM runtime_message_attachments WHERE attachment_id = ?
             )`,
        )
        .run(gcAfter, Date.now(), id, id);
    }
  }

  listEvents(conversationId: ConversationId): Event[] {
    return this.db
      .query<EventRow, [string]>(
        "SELECT payload_json FROM runtime_events WHERE conversation_id = ? ORDER BY time, id",
      )
      .all(conversationId)
      .map((row) => eventSchema.parse(JSON.parse(row.payload_json)) as Event);
  }

  listEventsByRun(runId: RunId): Event[] {
    return this.db
      .query<EventRow, [string]>(
        "SELECT payload_json FROM runtime_events WHERE run_id = ? ORDER BY time, id",
      )
      .all(runId)
      .map((row) => eventSchema.parse(JSON.parse(row.payload_json)) as Event);
  }

  appendTrace(trace: TraceEvent): void {
    const parsed = traceEventSchema.parse(trace) as TraceEvent;

    this.db
      .query(
        `INSERT INTO runtime_traces (
          id, conversation_id, run_id, type, level, payload_json, time
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.conversationId ?? null,
        parsed.runId ?? null,
        parsed.type,
        parsed.level,
        encode(parsed.payload),
        parsed.time,
      );
  }

  private insertConversation(conversation: Conversation): void {
    this.db
      .query(
        `INSERT INTO runtime_conversations (
          id, title, version, status_json, active_head_run_id, revision,
          parent_id, summary_json, share_json, time_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.version,
        encode(conversation.status),
        conversation.activeHeadRunId ?? null,
        conversation.revision,
        conversation.parentId ?? null,
        conversation.summary ? encode(conversation.summary) : null,
        conversation.share ? encode(conversation.share) : null,
        encode(conversation.time),
        conversation.metadata ? encode(conversation.metadata) : null,
      );
  }

  private updateConversationAtRevision(
    conversation: Conversation,
    expectedRevision: number,
  ): void {
    const result = this.db
      .query(
        `UPDATE runtime_conversations SET
          title = ?,
          version = ?,
          status_json = ?,
          active_head_run_id = ?,
          revision = ?,
          parent_id = ?,
          summary_json = ?,
          share_json = ?,
          time_json = ?,
          metadata_json = ?
        WHERE id = ? AND revision = ?`,
      )
      .run(
        conversation.title,
        conversation.version,
        encode(conversation.status),
        conversation.activeHeadRunId ?? null,
        conversation.revision,
        conversation.parentId ?? null,
        conversation.summary ? encode(conversation.summary) : null,
        conversation.share ? encode(conversation.share) : null,
        encode(conversation.time),
        conversation.metadata ? encode(conversation.metadata) : null,
        conversation.id,
        expectedRevision,
      );
    if (result.changes === 1) {
      return;
    }

    const current = this.db
      .query<{ revision: number }, [string]>(
        "SELECT revision FROM runtime_conversations WHERE id = ?",
      )
      .get(conversation.id);
    throw new RuntimeConversationRevisionConflictError(
      conversation.id,
      expectedRevision,
      current?.revision ?? null,
    );
  }

  private resolveLineage(
    conversationId: ConversationId,
    headRunId: RunId,
  ): ResolvedLineageRun[] {
    const reverseLineage: ResolvedLineageRun[] = [];
    const visited = new Set<RunId>();
    let currentRunId: RunId | undefined = headRunId;

    while (currentRunId) {
      const run = this.getLineageRun(conversationId, headRunId, currentRunId);
      if (!run) {
        this.failHistoryIntegrity(
          "DAG_INCOMPLETE_RUN",
          conversationId,
          currentRunId,
          { headRunId, runId: currentRunId, reason: "missing_run" },
        );
      }
      if (run.conversationId !== conversationId) {
        this.failHistoryIntegrity(
          "DAG_INCOMPLETE_RUN",
          conversationId,
          run.id,
          { headRunId, runId: run.id, reason: "conversation_ownership_mismatch" },
        );
      }
      visited.add(run.id);
      const messages = this.resolveRunMessages(conversationId, headRunId, run);
      reverseLineage.push({ run, ...messages });

      if (run.parentRunId && visited.has(run.parentRunId)) {
        this.failHistoryIntegrity(
          "DAG_CYCLE",
          conversationId,
          run.id,
          { headRunId, runId: run.id },
        );
      }
      currentRunId = run.parentRunId;
    }

    return reverseLineage.reverse();
  }

  private resolveRunMessages(
    conversationId: ConversationId,
    headRunId: RunId,
    run: Run,
  ): { userMessage: UserMessage; assistantMessage: AssistantMessage } {
    const userMessage = run.parentMessageId
      ? this.getLineageMessage(
          conversationId,
          headRunId,
          run,
          run.parentMessageId,
          "invalid_user_message_payload",
        )
      : null;
    if (!userMessage) {
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        run.id,
        { headRunId, runId: run.id, reason: "missing_user_message" },
      );
    }
    if (userMessage.role !== "user" || userMessage.conversationId !== conversationId) {
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        run.id,
        { headRunId, runId: run.id, reason: "invalid_user_message" },
      );
    }

    const assistantMessage = run.assistantMessageId
      ? this.getLineageMessage(
          conversationId,
          headRunId,
          run,
          run.assistantMessageId,
          "invalid_assistant_message_payload",
        )
      : null;
    if (!assistantMessage) {
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        run.id,
        { headRunId, runId: run.id, reason: "missing_assistant_message" },
      );
    }
    if (
      assistantMessage.role !== "assistant"
      || assistantMessage.conversationId !== conversationId
      || assistantMessage.runId !== run.id
      || assistantMessage.parentId !== userMessage.id
    ) {
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        run.id,
        { headRunId, runId: run.id, reason: "invalid_assistant_message" },
      );
    }

    return { userMessage, assistantMessage };
  }

  private getLineageRun(
    conversationId: ConversationId,
    headRunId: RunId,
    runId: RunId,
  ): Run | null {
    try {
      return this.getRun(runId);
    } catch (error) {
      if (!isPersistedPayloadParseError(error)) {
        throw error;
      }
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        runId,
        { headRunId, runId, reason: "invalid_run_payload" },
      );
    }
  }

  private getLineageMessage(
    conversationId: ConversationId,
    headRunId: RunId,
    run: Run,
    messageId: MessageId,
    reason: "invalid_user_message_payload" | "invalid_assistant_message_payload",
  ): Message | null {
    try {
      return this.getMessage(messageId);
    } catch (error) {
      if (!isPersistedPayloadParseError(error)) {
        throw error;
      }
      this.failHistoryIntegrity(
        "DAG_INCOMPLETE_RUN",
        conversationId,
        run.id,
        { headRunId, runId: run.id, reason },
      );
    }
  }

  private failHistoryIntegrity(
    code: Exclude<RuntimeHistoryDiagnostic["code"], "LEGACY_DAG_BACKFILL_INVALID">,
    conversationId: ConversationId,
    runId: RunId,
    details: Record<string, unknown>,
  ): never {
    const diagnosticId = `diag_${code.toLowerCase()}_${conversationId}_${String(
      details.headRunId ?? runId,
    )}_${runId}` as RuntimeHistoryDiagnostic["id"];
    this.db
      .query(
        `INSERT OR IGNORE INTO runtime_history_diagnostics (
          id, conversation_id, code, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(diagnosticId, conversationId, code, encode(details), Date.now());
    throw new RuntimeHistoryIntegrityError(code, conversationId, runId, details);
  }

  listTraces(runId: RunId): TraceEvent[] {
    return this.db
      .query<TraceRow, [string]>(
        "SELECT * FROM runtime_traces WHERE run_id = ? ORDER BY time, id",
      )
      .all(runId)
      .map((row) => ({
        id: row.id as TraceEvent["id"],
        conversationId: row.conversation_id
          ? (row.conversation_id as ConversationId)
          : undefined,
        runId: row.run_id ? (row.run_id as RunId) : undefined,
        type: row.type,
        level: row.level,
        time: row.time,
        payload: decode<Record<string, unknown>>(row.payload_json) ?? {},
      }));
  }
}

function extractConversationId(properties: Record<string, unknown>): string | null {
  const info = properties.info;
  if (isRecord(info) && typeof info.conversationId === "string") {
    return info.conversationId;
  }

  if (isRecord(info) && typeof info.id === "string" && info.id.startsWith("conv_")) {
    return info.id;
  }

  const part = properties.part;
  if (isRecord(part) && typeof part.conversationId === "string") {
    return part.conversationId;
  }

  if (typeof properties.conversationId === "string") {
    return properties.conversationId;
  }

  return null;
}

function extractRunId(properties: Record<string, unknown>): string | null {
  const info = properties.info;
  if (isRecord(info) && typeof info.runId === "string") {
    return info.runId;
  }

  if (isRecord(info) && typeof info.id === "string" && info.id.startsWith("run_")) {
    return info.id;
  }

  if (typeof properties.runId === "string") {
    return properties.runId;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conversationFromRow(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    title: row.title,
    version: row.version,
    status: decode(row.status_json),
    activeHeadRunId: row.active_head_run_id ?? undefined,
    revision: row.revision,
    parentId: row.parent_id ?? undefined,
    summary: decode(row.summary_json),
    share: decode(row.share_json),
    time: decode(row.time_json),
    metadata: decode(row.metadata_json),
  }) as Conversation;
}

function runFromRow(row: RunRow): Run {
  return runSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    parentRunId: row.parent_run_id ?? undefined,
    supersedesRunId: row.supersedes_run_id ?? undefined,
    parentMessageId: row.parent_message_id ?? undefined,
    assistantMessageId: row.assistant_message_id ?? undefined,
    agentMode: row.agent_mode,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    input: decode(row.input_json),
    output: decode(row.output_json),
    usage: decode(row.usage_json),
    cost: decode(row.cost_json),
    finish: row.finish ?? undefined,
    error: decode(row.error_json),
    time: decode(row.time_json),
    limits: decode(row.limits_json),
    metadata: decode(row.metadata_json),
  }) as Run;
}

function isPersistedPayloadParseError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof ZodError;
}

function historyDiagnosticFromRow(row: RuntimeHistoryDiagnosticRow): RuntimeHistoryDiagnostic {
  return {
    id: row.id as RuntimeHistoryDiagnostic["id"],
    conversationId: row.conversation_id as ConversationId,
    code: row.code,
    details: decode<Record<string, unknown>>(row.details_json) ?? {},
    createdAt: row.created_at,
  };
}

function toolCallFromRow(row: ToolCallRow): ToolCall {
  return {
    id: row.id as ToolCallId,
    conversationId: row.conversation_id as ConversationId,
    runId: row.run_id as RunId,
    messageId: row.message_id as MessageId,
    partId: row.part_id ? (row.part_id as Part["id"]) : undefined,
    toolName: row.tool_name,
    input: decode<Record<string, unknown>>(row.input_json) ?? {},
    state: row.state,
    permissionId: row.permission_id ? (row.permission_id as PermissionId) : undefined,
    result: decode(row.result_json),
    error: decode(row.error_json),
    time: decode<ToolCall["time"]>(row.time_json) ?? { created: 0 },
    metadata: decode(row.metadata_json),
    authorization: row.authorization_json
      ? toolCallAuthorizationSnapshotSchema.parse(JSON.parse(row.authorization_json))
      : undefined,
  };
}

function permissionFromRow(row: PermissionRow): Permission {
  return permissionSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    status: row.status,
    toolId: row.tool_id,
    title: row.title,
    inputSummary: row.input_summary ?? undefined,
    risk: decode(row.risk_json),
    confirmation: decode(row.confirmation_json),
    presentation: decode(row.presentation_json),
    adapter: decode(row.adapter_json),
    decision: decode(row.decision_json),
    createdAt: row.created_at,
  }) as Permission;
}

function normalizeListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function sameRuntimeIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function contextPreparationClaimFromRow(
  row: ContextPreparationClaimRow,
): ContextPreparationClaim {
  return {
    runId: row.run_id as RunId,
    requestIndex: row.request_index,
    requestHash: row.request_hash,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    claimedAt: row.claimed_at,
    expiresAt: row.expires_at,
  };
}

function assertContextPreparationRequestKey(runId: RunId, requestIndex: number): void {
  if (!runId.startsWith("run_") || !Number.isSafeInteger(requestIndex) || requestIndex < 0) {
    throw new Error("Context preparation claim request key is invalid");
  }
}

function assertContextPreparationClaimRequest(
  request: ContextPreparationClaimRequest,
): void {
  assertContextPreparationRequestKey(request.runId, request.requestIndex);
  if (
    !isSha256(request.requestHash)
    || request.ownerId.length === 0
    || !Number.isSafeInteger(request.ttlMs)
    || request.ttlMs <= 0
  ) {
    throw new Error("Context preparation claim request is invalid");
  }
}

function assertContextPreparationClaim(claim: ContextPreparationClaim): void {
  assertContextPreparationRequestKey(claim.runId, claim.requestIndex);
  if (
    !isSha256(claim.requestHash)
    || claim.ownerId.length === 0
    || !Number.isSafeInteger(claim.fencingToken)
    || claim.fencingToken < 1
    || !Number.isSafeInteger(claim.claimedAt)
    || claim.claimedAt < 0
    || !Number.isSafeInteger(claim.expiresAt)
    || claim.expiresAt <= claim.claimedAt
  ) {
    throw new Error("Context preparation claim is invalid");
  }
}

function isSha256(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
