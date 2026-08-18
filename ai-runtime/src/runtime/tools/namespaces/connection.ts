import {
  connectionGetRequestSchema,
  connectionGetResponseSchema,
  connectionListRequestSchema,
  connectionListResponseSchema,
  connectionOpenRequestSchema,
  connectionOpenResponseSchema,
  type ConnectionGetRequest,
  type ConnectionGetResponse,
  type ConnectionListRequest,
  type ConnectionListResponse,
  type ConnectionOpenRequest,
  type ConnectionOpenResponse,
} from "../backend-read-contracts";
import { defineBackendTool } from "../contracts";
import type { RuntimeToolNamespace } from "../kernel";

export function createConnectionToolNamespace(): RuntimeToolNamespace {
  return {
    id: "connection",
    title: "Connections",
    description: "读取 NexusPilot 中已保存的数据库连接及其运行状态。",
    metadata: { capabilityModel: "connection_repository" },
    tools: [
      defineBackendTool<ConnectionListRequest, ConnectionListResponse>({
        id: "connection.list",
        title: "获取连接列表",
        description:
          "列出已保存的数据库连接，包含名称、数据库类型、环境、连接状态和可用于识别目标的非敏感地址信息。",
        metadata: { category: "connection", operation: "list" },
        inputSchema: connectionListRequestSchema,
        outputSchema: connectionListResponseSchema,
        executionTarget: "backend",
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "business_read",
        },
        limits: {
          timeoutMs: 10_000,
          maxResultBytes: 512 * 1024,
        },
      }),
      defineBackendTool<ConnectionGetRequest, ConnectionGetResponse>({
        id: "connection.get",
        title: "获取连接详情",
        description:
          "按 profileId 获取一个连接的非敏感配置、展示信息以及当前运行状态和数据库能力。",
        metadata: { category: "connection", operation: "get" },
        inputSchema: connectionGetRequestSchema,
        outputSchema: connectionGetResponseSchema,
        executionTarget: "backend",
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "business_read",
        },
        limits: {
          timeoutMs: 10_000,
          maxResultBytes: 128 * 1024,
        },
      }),
      defineBackendTool<ConnectionOpenRequest, ConnectionOpenResponse>({
        id: "connection.open",
        title: "打开连接",
        description:
          "按 profileId 打开并复用 NexusPilot 的共享数据库连接运行时；连接已打开时直接返回当前状态，不重复创建连接。",
        metadata: { category: "connection", operation: "open" },
        inputSchema: connectionOpenRequestSchema,
        outputSchema: connectionOpenResponseSchema,
        executionTarget: "backend",
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "workbench_state",
        },
        limits: {
          timeoutMs: 60_000,
          maxResultBytes: 128 * 1024,
        },
      }),
    ],
    resolveForRun: () => ({
      candidateToolIds: [
        "connection.list",
        "connection.get",
        "connection.open",
      ],
    }),
  };
}
