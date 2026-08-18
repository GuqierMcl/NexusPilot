import { Elysia } from "elysia";
import { detailError } from "../core/errors";
import {
  AUTO_APPROVE_MAX_RISKS,
  NETWORK_ACCESS_SCOPES,
  isAutoApproveMaxRisk,
  isNetworkAccessScope,
  type RuntimeSettingsSnapshot,
} from "../settings/contracts";
import type { RuntimeSettingsService } from "../settings/service";
import { jsonRequestBody } from "./openapi";

export function runtimeSettingsRoutes(service: RuntimeSettingsService) {
  return new Elysia({ prefix: "/v1", name: "runtime-settings-routes" })
    .get("/settings", () => serializeRuntimeSettings(service.snapshot()), {
      detail: {
        tags: ["运行时设置"],
        summary: "获取 AI Runtime 设置",
        description:
          "返回 Runtime 权威设置快照。设置只影响之后创建的新 Run。",
      },
    })
    .put("/settings", async ({ request }) => {
      const body = await parseJsonBody(request);
      const settings = parseRuntimeSettingsUpdate(body);
      if (!settings) {
        return detailError(422, "Invalid runtime settings request body");
      }

      return serializeRuntimeSettings(service.update(settings));
    }, {
      detail: {
        tags: ["运行时设置"],
        summary: "更新 AI Runtime 设置",
        description:
          "以完整快照替换 Runtime-owned 设置。仅允许已声明字段；设置只影响之后创建的新 Run。",
        requestBody: jsonRequestBody({
          type: "object",
          required: ["tool_policy", "network_policy"],
          additionalProperties: false,
          properties: {
            tool_policy: {
              type: "object",
              required: ["auto_approve_max_risk"],
              additionalProperties: false,
              properties: {
                auto_approve_max_risk: {
                  type: "string",
                  enum: [...AUTO_APPROVE_MAX_RISKS],
                  description: "允许自动执行的最高风险级别。",
                },
              },
            },
            network_policy: {
              type: "object",
              required: ["access_scope"],
              additionalProperties: false,
              properties: {
                access_scope: {
                  type: "string",
                  enum: [...NETWORK_ACCESS_SCOPES],
                  description: "web 工具可访问的网络范围。",
                },
              },
            },
          },
        }),
      },
    });
}

function serializeRuntimeSettings(settings: RuntimeSettingsSnapshot) {
  return {
    tool_policy: {
      auto_approve_max_risk: settings.toolPolicy.autoApproveMaxRisk,
    },
    network_policy: {
      access_scope: settings.networkPolicy.accessScope,
    },
  };
}

function parseRuntimeSettingsUpdate(
  value: unknown,
): RuntimeSettingsSnapshot | null {
  if (!isStrictRecord(value, ["tool_policy", "network_policy"])) {
    return null;
  }
  const toolPolicy = value.tool_policy;
  const networkPolicy = value.network_policy;
  if (
    !isStrictRecord(toolPolicy, ["auto_approve_max_risk"]) ||
    !isAutoApproveMaxRisk(toolPolicy.auto_approve_max_risk) ||
    !isStrictRecord(networkPolicy, ["access_scope"]) ||
    !isNetworkAccessScope(networkPolicy.access_scope)
  ) {
    return null;
  }
  return {
    toolPolicy: {
      autoApproveMaxRisk: toolPolicy.auto_approve_max_risk,
    },
    networkPolicy: {
      accessScope: networkPolicy.access_scope,
    },
  };
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isStrictRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(record, key))
  );
}
