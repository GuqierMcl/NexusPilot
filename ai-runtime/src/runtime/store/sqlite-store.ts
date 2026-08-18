import type { RuntimeDatabase } from "../../storage/runtime-database";
import { runtimeEventToEnvelope } from "../events/event-envelope";
import type { RuntimeEventBus } from "../events/event-bus";
import {
  conversationSchema,
  eventSchema,
  messageSchema,
  partSchema,
  permissionSchema,
  runSchema,
  traceEventSchema,
} from "../core/schemas";
import type {
  Conversation,
  ConversationId,
  Event,
  Message,
  MessageId,
  Part,
  Permission,
  PermissionId,
  Run,
  RunId,
  ToolCall,
  ToolCallId,
  TraceEvent,
} from "../core/types";

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
  parent_id: string | null;
  summary_json: string | null;
  share_json: string | null;
  time_json: string;
  metadata_json: string | null;
}

interface RunRow {
  id: string;
  conversation_id: string;
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

export interface ListConversationsOptions {
  limit?: number;
  withMessagesOnly?: boolean;
}

export interface RuntimeSqliteStoreOptions {
  eventBus?: RuntimeEventBus;
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

  constructor(
    private readonly db: RuntimeDatabase,
    private readonly options: RuntimeSqliteStoreOptions = {},
  ) {}

  close(): void {
    if (this.closed) {
      return;
    }

    this.db.close();
    this.closed = true;
  }

  commitRunStart(input: {
    conversation: Conversation;
    userMessage: Message;
    run: Run;
    assistantMessage: Message;
    events: Event[];
    traces: TraceEvent[];
    removedMessageIds?: MessageId[];
  }): void {
    const conversation = conversationSchema.parse(input.conversation) as Conversation;
    const userMessage = messageSchema.parse(input.userMessage) as Message;
    const run = runSchema.parse(input.run) as Run;
    const assistantMessage = messageSchema.parse(input.assistantMessage) as Message;
    const events = input.events.map((event) => eventSchema.parse(event) as Event);
    const traces = input.traces.map((trace) => traceEventSchema.parse(trace) as TraceEvent);
    const removedMessageIds = [...new Set(input.removedMessageIds ?? [])];

    const tx = this.db.transaction(() => {
      if (removedMessageIds.length > 0) {
        this.removeMessageTail(conversation.id, removedMessageIds);
      }

      this.saveConversation(conversation);
      this.saveMessage(userMessage);
      this.saveRun(run);
      this.saveMessage(assistantMessage);
      events.forEach((event) => this.insertEvent(event));
      traces.forEach((trace) => this.appendTrace(trace));
    });

    tx();
    events.forEach((event) => this.options.eventBus?.publish(runtimeEventToEnvelope(event)));
  }

  saveConversation(conversation: Conversation): void {
    const parsed = conversationSchema.parse(conversation) as Conversation;

    this.db
      .query(
        `INSERT INTO runtime_conversations (
          id, title, version, status_json, parent_id, summary_json, share_json, time_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          version = excluded.version,
          status_json = excluded.status_json,
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

    this.db.query("DELETE FROM runtime_conversations WHERE id = ?").run(id);

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
          id, conversation_id, parent_message_id, assistant_message_id, agent_mode,
          provider_id, model_id, status, input_json, output_json, usage_json, cost_json,
          finish, error_json, time_json, limits_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const tx = this.db.transaction((record: Message) => {
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
      });
    });

    tx(parsed);
  }

  getMessage(id: MessageId): Message | null {
    const row = this.db
      .query<MessageRow, [string]>("SELECT message_json FROM runtime_messages WHERE id = ?")
      .get(id);

    return row ? (messageSchema.parse(JSON.parse(row.message_json)) as Message) : null;
  }

  listMessages(conversationId: ConversationId): Message[] {
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
      .map((row) => messageSchema.parse(JSON.parse(row.message_json)) as Message);
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
    this.db
      .query(
        `INSERT INTO runtime_tool_calls (
          id, conversation_id, run_id, message_id, part_id, tool_name, state,
          input_json, permission_id, result_json, error_json, time_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          part_id = excluded.part_id,
          state = excluded.state,
          input_json = excluded.input_json,
          permission_id = excluded.permission_id,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          time_json = excluded.time_json,
          metadata_json = excluded.metadata_json`,
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
