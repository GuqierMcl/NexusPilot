import { Elysia } from "elysia";
import { success } from "../core/response";
import { APP_VERSION } from "../version";
import type { BackendBridgeManager } from "../backend-bridge";

export function healthRoutes(backendBridge: BackendBridgeManager) {
  return new Elysia({ name: "health-routes" }).get("/health", () =>
    success({
      status: "ok",
      version: APP_VERSION,
      backendBridge: backendBridge.snapshot(),
    }), {
    detail: {
      tags: ["健康检查"],
      summary: "获取 AI Runtime 健康状态",
      description: "返回 Runtime 健康状态、应用版本号和只读 Backend Bridge 诊断。",
    },
    },
  );
}
