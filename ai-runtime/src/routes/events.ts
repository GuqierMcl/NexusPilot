import { Elysia, t } from "elysia";
import { detailError } from "../core/errors";
import {
  isRuntimeId,
  type ConversationId,
  type RunId,
  type RuntimeEventBus,
  type RuntimeEventEnvelope,
  type RuntimeEventScopeFilter,
} from "../runtime";

export interface EventRouteDeps {
  eventBus: RuntimeEventBus | null;
}

export function eventRoutes(deps: EventRouteDeps) {
  return new Elysia({ prefix: "/v1", name: "event-routes" })
    .get("/events", ({ query, request }) => {
      if (!deps.eventBus) {
        return detailError(503, "Runtime EventBus not initialized");
      }

      const filter = parseScopeQuery(query, new URL(request.url).searchParams);
      if (filter instanceof Response) {
        return filter;
      }

      return createSseResponse(deps.eventBus, filter);
    }, {
      detail: {
        tags: ["事件"],
        summary: "订阅 AI Runtime live events",
        description:
          "Live-only scoped SSE。该接口不支持 cursor replay；恢复应通过 Snapshot Read API 完成。",
        parameters: [
          {
            name: "conversation_id",
            in: "query",
            required: false,
            description: "只订阅指定 Runtime conversation 的 live events。",
            schema: { type: "string" },
          },
          {
            name: "run_id",
            in: "query",
            required: false,
            description: "只订阅指定 Runtime run 的 live events。",
            schema: { type: "string" },
          },
        ],
      },
      query: t.Object({
        conversation_id: t.Optional(t.String()),
        run_id: t.Optional(t.String()),
      }),
    });
}

function parseScopeQuery(
  query: {
    conversation_id?: string;
    run_id?: string;
  },
  searchParams: URLSearchParams,
): RuntimeEventScopeFilter | Response {
  if (searchParams.has("cursor")) {
    return detailError(422, "cursor is not supported for live-only events");
  }

  if (query.conversation_id && query.run_id) {
    return detailError(422, "conversation_id and run_id are mutually exclusive");
  }

  if (query.conversation_id) {
    if (!isRuntimeId(query.conversation_id, "conv")) {
      return detailError(422, "Invalid conversation_id query parameter");
    }

    return {
      kind: "conversation",
      conversation_id: query.conversation_id as ConversationId,
    };
  }

  if (query.run_id) {
    if (!isRuntimeId(query.run_id, "run")) {
      return detailError(422, "Invalid run_id query parameter");
    }

    return {
      kind: "run",
      run_id: query.run_id as RunId,
    };
  }

  return { kind: "global" };
}

function createSseResponse(
  eventBus: RuntimeEventBus,
  filter: RuntimeEventScopeFilter,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const subscription = eventBus.subscribe(filter, (event) => {
        controller.enqueue(encoder.encode(formatSseEvent(event)));
      });
      unsubscribe = subscription.unsubscribe;
      keepAliveTimer = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15_000);
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function formatSseEvent(event: RuntimeEventEnvelope): string {
  return [
    `id: ${event.id}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
