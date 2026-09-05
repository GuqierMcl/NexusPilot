import { Elysia } from "elysia";
import { success } from "../core/response";
import { APP_VERSION } from "../version";
import type { BackendBridgeManager } from "../backend-bridge";
import type { RuntimeAttachmentService, RuntimeSqliteStore } from "../runtime";

export function healthRoutes(
  backendBridge: BackendBridgeManager,
  attachmentService?: RuntimeAttachmentService | null,
  runtimeStore?: RuntimeSqliteStore | null,
) {
  return new Elysia({ name: "health-routes" }).get("/health", ({ set }) => {
    const attachments = attachmentService?.diagnostics() ?? {
      status: "unavailable" as const,
      warnings: [],
    };
    const context = runtimeStore?.contextDiagnostics() ?? {
      status: "unavailable" as const,
      warnings: [],
    };
    const unhealthy = !runtimeStore
      || attachments.status === "unavailable"
      || context.status === "unavailable";
    if (unhealthy) set.status = 503;
    return success({
      status: unhealthy ? "unhealthy" as const : "ok" as const,
      version: APP_VERSION,
      backendBridge: backendBridge.snapshot(),
      attachments,
      context,
    });
  }, {
    detail: {
      tags: ["健康检查"],
      summary: "获取 AI Runtime 健康状态",
      description: "返回 Runtime 健康状态、应用版本号、Backend Bridge、附件与上下文子系统的只读诊断。",
    },
  });
}
