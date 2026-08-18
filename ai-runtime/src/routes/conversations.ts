import { Elysia, t } from "elysia";
import { detailError } from "../core/errors";
import {
  createRuntimeId,
  parseMessageHistoryFormat,
  projectConversationSummary,
  projectMessageHistory,
  projectRunSnapshot,
  interruptStoredRun,
  withConversationTitleMetadata,
  type ActiveRunRegistry,
  type BackendToolExecutor,
  type Conversation,
  type ConversationId,
  type Event,
  type InterruptReason,
  type InterruptStoredRunResult,
  type Message,
  type Run,
  type RuntimeRunInterruptStore,
  type PreparedToolInvocationRegistry,
} from "../runtime";
import {
  jsonRequestBody,
  stringSchema,
  unknownRecordSchema,
  type OpenApiSchema,
} from "./openapi";

export interface RuntimeConversationReadStore {
  saveConversation(conversation: Conversation): void;
  deleteConversation(conversationId: ConversationId): Conversation | null;
  listConversations(options?: { limit?: number; withMessagesOnly?: boolean }): Conversation[];
  getConversation(id: ConversationId): Conversation | null;
  listMessages(conversationId: ConversationId): Message[];
  listRunsByConversation(conversationId: ConversationId): Run[];
  appendEvent(event: Event): void;
}

export interface ConversationRouteDeps {
  runtimeStore: (RuntimeConversationReadStore & RuntimeRunInterruptStore) | null;
  activeRuns?: ActiveRunRegistry;
  backendToolExecutor?: BackendToolExecutor;
  preparedInvocations?: PreparedToolInvocationRegistry;
  now?: () => number;
  createId?: typeof createRuntimeId;
}

export function conversationRoutes(deps: ConversationRouteDeps) {
  return new Elysia({ prefix: "/v1", name: "conversation-routes" })
    .post("/conversations", async ({ request, set }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const body = await parseOptionalJsonBody(request);
      const parsed = parseConversationCreateRequestBody(body);
      if (!parsed) {
        return detailError(422, "Invalid conversation creation request body");
      }

      const now = deps.now ?? Date.now;
      const createId = deps.createId ?? createRuntimeId;
      const created = now();
      const conversation: Conversation = {
        id: createId("conv"),
        title: parsed.title ?? "新对话",
        version: "1",
        status: { type: "idle" },
        time: { created, updated: created },
        metadata: withConversationTitleMetadata(parsed.metadata, {
          source: parsed.title ? "user" : "fallback",
        }),
      };

      store.saveConversation(conversation);
      store.appendEvent({
        id: createId("evt"),
        type: "conversation.created",
        properties: { info: conversation },
        time: created,
      });

      set.status = 201;
      return {
        conversation: projectConversationSummary(conversation),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "显式创建空 Runtime 对话",
        description:
          "低层显式创建 idle Runtime conversation。当前前端新建对话不会调用该接口预创建占位对话，首条真实消息应通过 POST /v1/runs 创建 conversation。",
        requestBody: jsonRequestBody(
          conversationCreateRequestSchema,
          "显式创建空 Runtime conversation 的请求参数。title 和 metadata 均为可选字段。",
        ),
      },
    })
    .get("/conversations", ({ query }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const limit = parseLimit(query.limit);
      if (limit === null) {
        return detailError(422, "Invalid limit query parameter");
      }

      return {
        conversations: store
          .listConversations({ limit, withMessagesOnly: true })
          .map(projectConversationSummary),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "列出 Runtime 对话",
        description:
          "返回最近更新且已有消息记录的 Runtime conversation 摘要，用于重启恢复和对话列表。",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            description: "返回数量，范围 1-100，默认 50。",
            schema: { type: "string" },
          },
        ],
      },
      query: t.Object({
        limit: t.Optional(t.String({ description: "返回数量，范围 1-100，默认 50。" })),
      }),
    })
    .get("/conversations/:conversationId", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const conversation = store.getConversation(params.conversationId as ConversationId);
      if (!conversation) {
        return detailError(404, `Conversation ${params.conversationId} not found`);
      }

      return { conversation: projectConversationSummary(conversation) };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "获取 Runtime 对话详情",
        description: "返回 Runtime conversation 当前事实状态。",
        parameters: [conversationIdParameter],
      },
    })
    .patch("/conversations/:conversationId", async ({ params, request }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const body = await parseOptionalJsonBody(request);
      const parsed = parseConversationRenameRequestBody(body);
      if (!parsed) {
        return detailError(422, "Conversation title must be 1-120 characters");
      }

      return updateConversation({
        deps,
        store,
        conversationId: params.conversationId as ConversationId,
        mutate: (conversation, now) => ({
          ...conversation,
          title: parsed.title,
          time: { ...conversation.time, updated: now },
          metadata: withConversationTitleMetadata(conversation.metadata, {
            source: "user",
          }),
        }),
      });
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "重命名 Runtime 对话",
        description:
          "修改 Runtime conversation title。用户界面文案称为对话；底层资源仍为 conversation。",
        parameters: [conversationIdParameter],
        requestBody: jsonRequestBody(
          conversationRenameRequestSchema,
          "对话重命名参数。",
        ),
      },
    })
    .post("/conversations/:conversationId/archive", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      return updateConversation({
        deps,
        store,
        conversationId: params.conversationId as ConversationId,
        requireNoActiveRun: true,
        mutate: (conversation, now) => ({
          ...conversation,
          status: { type: "archived" },
          time: { ...conversation.time, updated: now, archived: now },
        }),
      });
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "归档 Runtime 对话",
        description: "将 Runtime conversation 标记为 archived，并记录 archived 时间。",
        parameters: [conversationIdParameter],
      },
    })
    .post("/conversations/:conversationId/unarchive", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      return updateConversation({
        deps,
        store,
        conversationId: params.conversationId as ConversationId,
        requireNoActiveRun: true,
        mutate: (conversation, now) => {
          const { archived: _archived, ...time } = conversation.time;
          return {
            ...conversation,
            status: { type: "idle" },
            time: { ...time, updated: now },
          };
        },
      });
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "取消归档 Runtime 对话",
        description: "恢复 archived Runtime conversation 到 regular/idle 状态。",
        parameters: [conversationIdParameter],
      },
    })
    .post("/conversations/:conversationId/pin", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      return updateConversation({
        deps,
        store,
        conversationId: params.conversationId as ConversationId,
        mutate: (conversation, now) => ({
          ...conversation,
          metadata: setPinnedAt(conversation.metadata, now),
          time: { ...conversation.time, updated: now },
        }),
      });
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "置顶 Runtime 对话",
        description: "在 conversation metadata.ui.pinnedAt 写入置顶时间。",
        parameters: [conversationIdParameter],
      },
    })
    .post("/conversations/:conversationId/unpin", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      return updateConversation({
        deps,
        store,
        conversationId: params.conversationId as ConversationId,
        mutate: (conversation, now) => ({
          ...conversation,
          metadata: unsetPinnedAt(conversation.metadata),
          time: { ...conversation.time, updated: now },
        }),
      });
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "取消置顶 Runtime 对话",
        description: "从 conversation metadata.ui 移除 pinnedAt。",
        parameters: [conversationIdParameter],
      },
    })
    .delete("/conversations/:conversationId", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const conversationId = params.conversationId as ConversationId;
      const conversation = store.getConversation(conversationId);
      if (!conversation) {
        return detailError(404, `Conversation ${params.conversationId} not found`);
      }

      if (hasActiveRun(conversation)) {
        return detailError(409, "Conversation has an active run");
      }

      const deleted = store.deleteConversation(conversationId);
      const now = deps.now?.() ?? Date.now();
      if (deleted) {
        store.appendEvent({
          id: (deps.createId ?? createRuntimeId)("evt"),
          type: "conversation.deleted",
          properties: { info: deleted },
          time: now,
        });
      }

      return { deleted: true, conversation_id: conversationId };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "删除 Runtime 对话",
        description:
          "永久删除 Runtime conversation。SQLite foreign keys 会级联删除其 Run、Message、Part、ToolCall 与 Permission。",
        parameters: [conversationIdParameter],
      },
    })
    .post("/conversations/:conversationId/interrupt-active-run", async ({ params, request }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const body = await parseOptionalJsonBody(request);
      const parsed = parseInterruptRequestBody(body);
      if (!parsed) {
        return detailError(422, "Invalid conversation interrupt request body");
      }

      const conversationId = params.conversationId as ConversationId;
      const conversation = store.getConversation(conversationId);
      if (!conversation) {
        return detailError(404, `Conversation ${params.conversationId} not found`);
      }

      const result =
        deps.activeRuns?.interruptConversation(conversationId, parsed) ??
        interruptActiveStoredConversationRun({
          store,
          conversation,
          reason: parsed.reason,
          message: parsed.message,
        });

      if (!result) {
        return {
          conversation_id: conversation.id,
          run_id: null,
          interrupted: false,
          reason: "no_active_run",
        };
      }

      deps.preparedInvocations?.clearRun(result.run.id);
      await deps.backendToolExecutor?.cleanupRun?.(result.run.id);
      return projectConversationInterruptResponse(result);
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "中断对话当前 active Run",
        description:
          "按 conversationId 中断当前 active run 的便捷 command。内部必须解析到明确 runId；没有 active run 时返回 200 no-op。",
        parameters: [conversationIdParameter],
        requestBody: jsonRequestBody(
          conversationInterruptRequestSchema,
          "中断当前对话 active run 的请求参数；reason 默认 user_stop。",
        ),
      },
    })
    .get("/conversations/:conversationId/messages", ({ params, query }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const conversation = store.getConversation(params.conversationId as ConversationId);
      if (!conversation) {
        return detailError(404, `Conversation ${params.conversationId} not found`);
      }

      const format = parseMessageHistoryFormat(query.format);
      if (!format) {
        return detailError(422, "Invalid message history format");
      }

      const messages = store.listMessages(conversation.id);
      return {
        conversation_id: conversation.id,
        format,
        messages: projectMessageHistory(messages, format),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "获取 Runtime 对话消息历史",
        description:
          "从 Runtime Store 读取消息历史。format=runtime 返回内部 Message；format=ui 返回 assistant-ui friendly message shape；format=ai_sdk 返回 AI SDK 7 UIMessage shape。",
        parameters: [
          conversationIdParameter,
          {
            name: "format",
            in: "query",
            required: false,
            description: "消息投影格式，默认 runtime。",
            schema: { type: "string", enum: ["runtime", "ui", "ai_sdk"] },
          },
        ],
      },
      query: t.Object({
        format: t.Optional(
          t.Union(
            [t.Literal("runtime"), t.Literal("ui"), t.Literal("ai_sdk")],
            { description: "消息投影格式，默认 runtime。" },
          ),
        ),
      }),
    })
    .get("/conversations/:conversationId/runs", ({ params }) => {
      const store = requireStore(deps.runtimeStore);
      if (store instanceof Response) return store;

      const conversation = store.getConversation(params.conversationId as ConversationId);
      if (!conversation) {
        return detailError(404, `Conversation ${params.conversationId} not found`);
      }

      return {
        conversation_id: conversation.id,
        runs: store.listRunsByConversation(conversation.id).map(projectRunSnapshot),
      };
    }, {
      detail: {
        tags: ["对话与历史"],
        summary: "列出 Runtime 对话下的 Runs",
        description: "返回某个 conversation 下的 Run 当前快照列表。",
        parameters: [conversationIdParameter],
      },
    });
}

const conversationIdParameter = {
  name: "conversationId",
  in: "path" as const,
  required: true,
  description: "Runtime conversation id。",
  schema: { type: "string" },
} as const;

function requireStore<TStore>(store: TStore | null): TStore | Response {
  return store ?? detailError(503, "Runtime Store not initialized");
}

function parseLimit(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const limit = Number(value);
  if (limit < 1 || limit > 100) {
    return null;
  }

  return limit;
}

interface ConversationCreateRequestBody {
  title?: string;
  metadata?: Record<string, unknown>;
}

const MAX_CONVERSATION_TITLE_LENGTH = 120;

interface ConversationRenameRequestBody {
  title: string;
}

async function parseOptionalJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text) {
      return {};
    }

    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function parseConversationCreateRequestBody(
  body: unknown,
): ConversationCreateRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  for (const key of Object.keys(body)) {
    if (key !== "title" && key !== "metadata") {
      return null;
    }
  }

  const result: ConversationCreateRequestBody = {};

  if ("title" in body) {
    if (typeof body.title !== "string") {
      return null;
    }

    const title = body.title.trim();
    if (title.length > 0) {
      result.title = title;
    }
  }

  if ("metadata" in body) {
    if (!isRecord(body.metadata)) {
      return null;
    }

    result.metadata = body.metadata;
  }

  return result;
}

function parseConversationRenameRequestBody(
  body: unknown,
): ConversationRenameRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "title" || typeof body.title !== "string") {
    return null;
  }

  const title = body.title.trim();
  if (title.length < 1 || title.length > MAX_CONVERSATION_TITLE_LENGTH) {
    return null;
  }

  return { title };
}

interface InterruptRequestBody {
  reason: InterruptReason;
  message?: string;
  clientRequestId?: string;
}

function parseInterruptRequestBody(body: unknown): InterruptRequestBody | null {
  if (!isRecord(body)) {
    return null;
  }

  for (const key of Object.keys(body)) {
    if (key !== "reason" && key !== "message" && key !== "client_request_id") {
      return null;
    }
  }

  const reason = body.reason === undefined ? "user_stop" : body.reason;
  if (!isInterruptReason(reason)) {
    return null;
  }

  if (body.message !== undefined && typeof body.message !== "string") {
    return null;
  }

  if (body.client_request_id !== undefined && typeof body.client_request_id !== "string") {
    return null;
  }

  return {
    reason,
    ...(body.message ? { message: body.message } : {}),
    ...(body.client_request_id ? { clientRequestId: body.client_request_id } : {}),
  };
}

function updateConversation(input: {
  deps: ConversationRouteDeps;
  store: RuntimeConversationReadStore;
  conversationId: ConversationId;
  requireNoActiveRun?: boolean;
  mutate: (conversation: Conversation, now: number) => Conversation;
}) {
  const conversation = input.store.getConversation(input.conversationId);
  if (!conversation) {
    return detailError(404, `Conversation ${input.conversationId} not found`);
  }

  if (input.requireNoActiveRun && hasActiveRun(conversation)) {
    return detailError(409, "Conversation has an active run");
  }

  const now = input.deps.now?.() ?? Date.now();
  const updated = input.mutate(conversation, now);
  input.store.saveConversation(updated);
  input.store.appendEvent({
    id: (input.deps.createId ?? createRuntimeId)("evt"),
    type: "conversation.updated",
    properties: { info: updated },
    time: now,
  });

  return { conversation: projectConversationSummary(updated) };
}

function hasActiveRun(conversation: Conversation): boolean {
  return (
    conversation.status.type === "busy" ||
    conversation.status.type === "waiting_for_permission"
  );
}

function setPinnedAt(
  metadata: Record<string, unknown> | undefined,
  pinnedAt: number,
): Record<string, unknown> {
  const next = { ...(metadata ?? {}) };
  const ui = isRecord(next.ui) ? { ...next.ui } : {};
  ui.pinnedAt = pinnedAt;
  next.ui = ui;
  return next;
}

function unsetPinnedAt(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const next = { ...metadata };
  const ui = isRecord(next.ui) ? { ...next.ui } : null;
  if (ui) {
    delete ui.pinnedAt;
    if (Object.keys(ui).length > 0) {
      next.ui = ui;
    } else {
      delete next.ui;
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function interruptActiveStoredConversationRun(input: {
  store: RuntimeConversationReadStore & RuntimeRunInterruptStore;
  conversation: Conversation;
  reason: InterruptReason;
  message?: string;
}): InterruptStoredRunResult | null {
  const status = input.conversation.status;
  const runId =
    status.type === "busy" || status.type === "waiting_for_permission"
      ? status.runId
      : null;

  if (!runId) {
    return null;
  }

  return interruptStoredRun({
    store: input.store,
    runId,
    reason: input.reason,
    message: input.message,
  });
}

function projectConversationInterruptResponse(result: InterruptStoredRunResult) {
  return {
    conversation_id: result.run.conversationId,
    run_id: result.run.id,
    interrupted: result.interrupted,
    status: result.run.status,
  };
}

function isInterruptReason(value: unknown): value is InterruptReason {
  return (
    value === "user_stop" ||
    value === "client_disconnect" ||
    value === "runtime_shutdown" ||
    value === "runtime_recovered_stale_run" ||
    value === "tool_abort" ||
    value === "timeout" ||
    value === "unknown"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const conversationCreateRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      ...stringSchema,
      description: "可选对话标题；省略时使用低层默认标题。",
    },
    metadata: {
      ...unknownRecordSchema,
      description: "调用方附加的轻量 trace/debug 元数据。",
    },
  },
};

const conversationRenameRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: {
      ...stringSchema,
      description: "新的对话标题，trim 后长度必须为 1-120。",
    },
  },
};

const conversationInterruptRequestSchema: OpenApiSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      enum: [
        "user_stop",
        "client_disconnect",
        "runtime_shutdown",
        "runtime_recovered_stale_run",
        "tool_abort",
        "timeout",
        "unknown",
      ],
      description: "中断原因；前端用户停止默认使用 user_stop。",
    },
    message: {
      ...stringSchema,
      description: "可选中断说明，用于 trace/debug。",
    },
    client_request_id: {
      ...stringSchema,
      description: "可选客户端请求 id，用于调用方侧幂等追踪。",
    },
  },
};
