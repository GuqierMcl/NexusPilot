import { Elysia } from "elysia";
import { z } from "zod";
import { detailError } from "../core/errors";
import { isRuntimeId } from "../runtime/core/ids";
import type { ConversationId } from "../runtime/core/types";
import {
  ManualCompactionError,
  type ManualCompactionService,
} from "../runtime/context/manual-compaction-service";

const bodySchema = z
  .object({
    requestKey: z.string().min(1).max(128),
    providerId: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256),
  })
  .strict();
export function manualCompactionRoutes(
  service: ManualCompactionService | undefined,
) {
  return new Elysia({ prefix: "/v1/conversations", name: "manual-compactions" })
    .get("/:conversationId/compactions", ({ params }) => {
      if (!service) return detailError(503, "Runtime unavailable");
      return { operation: service.get(params.conversationId) };
    })
    .post("/:conversationId/compactions", async ({ params, request }) => {
      if (!service) return detailError(503, "Runtime unavailable");
      const body = bodySchema.safeParse(await request.json().catch(() => null));
      if (!body.success || !isRuntimeId(params.conversationId, "conv"))
        return detailError(422, "Invalid compaction request");
      try {
        return {
          operation: service.start(
            params.conversationId as ConversationId,
            body.data,
          ),
        };
      } catch (error) {
        console.error("[manual-compaction] request rejected", error);
        return detailError(
          error instanceof ManualCompactionError ? error.status : 422,
          error instanceof ManualCompactionError
            ? error.message
            : "当前模型无法用于压缩",
        );
      }
    })
    .post("/:conversationId/compactions/:operationId/cancel", ({ params }) => {
      if (!service) return detailError(503, "Runtime unavailable");
      try {
        return {
          operation: service.cancel(params.conversationId, params.operationId),
        };
      } catch (error) {
        return detailError(
          error instanceof ManualCompactionError ? error.status : 500,
          "无法取消压缩操作",
        );
      }
    });
}
