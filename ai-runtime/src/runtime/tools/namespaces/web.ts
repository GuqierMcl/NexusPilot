import { z } from "zod";
import type { RuntimeLogger } from "../../../core/logger";
import type { RuntimeToolNamespace } from "../kernel";
import { RuntimeToolExecutionError } from "../core";
import {
  executeWebFetch,
  WEB_FETCH_DEFAULT_MAX_BYTES,
  WEB_FETCH_DEFAULT_TIMEOUT_MS,
  webFetchInputSchema,
  type WebFetchOutput,
} from "../web-fetch";
import {
  executeWebPing,
  WEB_PING_TIMEOUT_MS,
  webPingInputSchema,
  webPingOutputSchema,
  type WebPingOutput,
} from "../web-ping";

export const webFetchOutputSchema = z.object({
  url: z.string().url(),
  finalUrl: z.string().url(),
  status: z.number().int(),
  contentType: z.string(),
  title: z.string().optional(),
  preview: z.string(),
  truncated: z.boolean(),
  bytesRead: z.number().int().nonnegative(),
});

export interface CreateWebToolNamespaceOptions {
  logger?: RuntimeLogger;
}

export function createWebToolNamespace(
  options: CreateWebToolNamespaceOptions = {},
): RuntimeToolNamespace {
  return {
    id: "web",
    title: "Web",
    description: "读取网页内容并执行网络诊断的 Runtime-local 工具。",
    metadata: { capabilityModel: "runtime_local" },
    tools: [{
      id: "web.fetch",
      title: "读取网页",
      description: "读取 HTTP(S) 网页并返回有界文本预览、最终地址与来源信息。",
      metadata: { category: "web", sourceType: "url" },
      inputSchema: webFetchInputSchema,
      outputSchema: webFetchOutputSchema,
      executionTarget: "runtime",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "external_network",
      },
      limits: {
        timeoutMs: WEB_FETCH_DEFAULT_TIMEOUT_MS,
        maxResultBytes: WEB_FETCH_DEFAULT_MAX_BYTES + 8_192,
      },
      execute: async (input, context) => {
        const result = await executeWebFetch(input, {
          abortSignal: context.abortSignal,
          networkAccessScope: context.networkAccessScope,
          onTunFakeIpAccepted: ({ hostname, address }) => {
            options.logger?.debug(
              {
                hostname,
                address,
                tunFakeIpCompatibility: true,
              },
              "Web fetch accepted TUN fake-IP",
            );
          },
          onResolvedAddressBlocked: ({ hostname, address }) => {
            options.logger?.debug(
              {
                hostname,
                address,
                resolvedAddressBlocked: true,
              },
              "Web fetch blocked resolved address",
            );
          },
        });
        if (!result.ok || !result.output) {
          const error = result.error;
          throw new RuntimeToolExecutionError(
            error?.code ?? "WEB_FETCH_FAILED",
            error?.message ?? "Web fetch failed.",
            error?.retryable ?? false,
            "no_effect",
            error?.details,
          );
        }
        return {
          summary:
            result.output.display?.summary ??
            `已读取 ${result.output.data.finalUrl}`,
          data: result.output.data as WebFetchOutput,
          ...(result.output.data.truncated
            ? { warnings: ["网页内容已按结果大小限制截断。"] }
            : {}),
        };
      },
    }, {
      id: "web.ping",
      title: "Ping 主机",
      description: "对单个 hostname 或 IP 地址执行有界 ICMP ping，返回可达性、丢包和可用的往返时延。",
      metadata: { category: "web", sourceType: "network_diagnostic" },
      inputSchema: webPingInputSchema,
      outputSchema: webPingOutputSchema,
      executionTarget: "runtime",
      risk: {
        mode: "static",
        level: "low",
        reversible: true,
        sideEffect: "external_network",
      },
      limits: {
        timeoutMs: WEB_PING_TIMEOUT_MS,
        maxResultBytes: 4_096,
      },
      execute: async (input, context) => {
        const result = await executeWebPing(input, {
          abortSignal: context.abortSignal,
          networkAccessScope: context.networkAccessScope,
        });
        if (!result.ok || !result.output) {
          const error = result.error;
          throw new RuntimeToolExecutionError(
            error?.code ?? "WEB_PING_FAILED",
            error?.message ?? "Web ping failed.",
            error?.retryable ?? false,
            "no_effect",
            error?.details,
          );
        }
        return {
          summary:
            result.output.display?.summary ??
            `Ping ${result.output.data.host} 已完成。`,
          data: result.output.data as WebPingOutput,
          ...(result.output.data.status === "unreachable"
            ? { warnings: ["未收到 ICMP 回复；目标可能离线、路由不可达或被防火墙拦截。"] }
            : {}),
        };
      },
    }],
    resolveForRun: () => ({ candidateToolIds: ["web.fetch", "web.ping"] }),
  };
}
