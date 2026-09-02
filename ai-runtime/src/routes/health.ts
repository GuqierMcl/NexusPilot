import { Elysia } from "elysia";
import { success } from "../core/response";
import { APP_VERSION } from "../version";
import type { BackendBridgeManager } from "../backend-bridge";
import type { RuntimeAttachmentService } from "../runtime";

export function healthRoutes(
  backendBridge: BackendBridgeManager,
  attachmentService?: RuntimeAttachmentService | null,
  runtimeDatabaseAvailable = false,
) {
  return new Elysia({ name: "health-routes" }).get("/health", ({ set }) => {
    const attachments = attachmentService?.diagnostics() ?? {
      status: "unavailable" as const,
      warnings: [],
    };
    const unhealthy = !runtimeDatabaseAvailable || attachments.status === "unavailable";
    if (unhealthy) set.status = 503;
    return success({
      status: unhealthy ? "unhealthy" as const : "ok" as const,
      version: APP_VERSION,
      backendBridge: backendBridge.snapshot(),
      attachments,
    });
  }, {
    detail: {
      tags: ["健康检查"],
      summary: "获取 AI Runtime 健康状态",
      description: "返回 Runtime 健康状态、应用版本号、Backend Bridge 与附件子系统的只读诊断。",
    },
  });
}
