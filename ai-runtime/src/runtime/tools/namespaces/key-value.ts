import {
  keyValueGetRequestSchema,
  keyValueGetResponseSchema,
  keyValueScanRequestSchema,
  keyValueScanResponseSchema,
  type KeyValueGetRequest,
  type KeyValueGetResponse,
  type KeyValueScanRequest,
  type KeyValueScanResponse,
} from "../backend-read-contracts";
import {
  keyValueCreateRequestSchema,
  keyValueDeleteRequestSchema,
  keyValueDeleteResponseSchema,
  keyValueMutationResponseSchema,
  keyValueRenameRequestSchema,
  keyValueSetRequestSchema,
  keyValueSetTtlRequestSchema,
  type KeyValueCreateRequest,
  type KeyValueDeleteRequest,
  type KeyValueDeleteResponse,
  type KeyValueMutationResponse,
  type KeyValueRenameRequest,
  type KeyValueSetRequest,
  type KeyValueSetTtlRequest,
} from "../key-value-contracts";
import { defineBackendTool } from "../contracts";
import type { RuntimeToolNamespace } from "../kernel";

export function createKeyValueToolNamespace(): RuntimeToolNamespace {
  return {
    id: "key_value",
    title: "Key/Value Data",
    description:
      "扫描和读取 Redis Key，并通过审批后的一次性计划执行精确单 Key mutation。",
    metadata: { capabilityModel: "key_value_browser" },
    tools: [
      defineBackendTool<KeyValueScanRequest, KeyValueScanResponse>({
        id: "key_value.scan",
        title: "扫描 Key",
        description:
          "在已打开的 Key/Value 连接中按 dbIndex、pattern 和 Redis SCAN 游标读取一批 Key。首次使用字符串 cursor=\"0\"；继续扫描时必须原样使用上一次返回的 nextCursor；done=true 表示本轮扫描完成。count 只是 Redis 扫描提示，不代表精确页大小，也不提供稳定总数。",
        metadata: { category: "key_value", operation: "scan" },
        inputSchema: keyValueScanRequestSchema,
        outputSchema: keyValueScanResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "business_read",
        },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 1024 * 1024,
        },
      }),
      defineBackendTool<KeyValueGetRequest, KeyValueGetResponse>({
        id: "key_value.get",
        title: "获取 Key 值",
        description:
          "在已打开的 Key/Value 连接中读取一个明确 Key 的类型、TTL、内存大小和类型化值。应使用用户明确给出的 Key，或 key_value.scan 返回的精确 Key；不要自行猜测 Key。",
        metadata: { category: "key_value", operation: "get" },
        inputSchema: keyValueGetRequestSchema,
        outputSchema: keyValueGetResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "static",
          level: "low",
          reversible: true,
          sideEffect: "business_read",
        },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 1024 * 1024,
        },
      }),
      defineBackendTool<KeyValueCreateRequest, KeyValueMutationResponse>({
        id: "key_value.create",
        title: "创建 Redis Key",
        description:
          "在指定 Redis DB 中创建一个不存在的精确 Key。后端使用临时键和原子切换保证并发出现同名 Key 时不覆盖；不接受 Redis 命令、Lua 或批量操作。",
        metadata: { category: "key_value", operation: "create" },
        inputSchema: keyValueCreateRequestSchema,
        outputSchema: keyValueMutationResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "dynamic",
          level: "high",
          reversible: false,
          sideEffect: "business_write",
        },
        prepare: { operation: "key_value.prepare_create" },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 256 * 1024,
        },
      }),
      defineBackendTool<KeyValueSetRequest, KeyValueMutationResponse>({
        id: "key_value.set",
        title: "替换 Redis Key 值",
        description:
          "整体替换一个已存在 Key 的类型化值，并可保留、移除或设置 TTL。后端会把审批时读取的值指纹绑定到一次性计划；Key 漂移时拒绝覆盖。",
        metadata: { category: "key_value", operation: "set" },
        inputSchema: keyValueSetRequestSchema,
        outputSchema: keyValueMutationResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "dynamic",
          level: "high",
          reversible: false,
          sideEffect: "business_write",
        },
        prepare: { operation: "key_value.prepare_set" },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 256 * 1024,
        },
      }),
      defineBackendTool<KeyValueRenameRequest, KeyValueMutationResponse>({
        id: "key_value.rename",
        title: "重命名 Redis Key",
        description:
          "把一个精确 Key 重命名到尚不存在的目标名称。后端同时绑定 source 值指纹与 destination absent 前置条件，不覆盖并发创建的目标。",
        metadata: { category: "key_value", operation: "rename" },
        inputSchema: keyValueRenameRequestSchema,
        outputSchema: keyValueMutationResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "dynamic",
          level: "high",
          reversible: false,
          sideEffect: "business_write",
        },
        prepare: { operation: "key_value.prepare_rename" },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 256 * 1024,
        },
      }),
      defineBackendTool<KeyValueSetTtlRequest, KeyValueMutationResponse>({
        id: "key_value.set_ttl",
        title: "修改 Redis Key TTL",
        description:
          "为一个精确 Key 设置过期秒数或移除 TTL。expire 会安排未来删除，因此后端按 destructive critical 风险要求强确认；值漂移时拒绝执行。",
        metadata: { category: "key_value", operation: "set_ttl" },
        inputSchema: keyValueSetTtlRequestSchema,
        outputSchema: keyValueMutationResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "dynamic",
          level: "high",
          reversible: "conditional",
          sideEffect: "business_write",
        },
        prepare: { operation: "key_value.prepare_set_ttl" },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 256 * 1024,
        },
      }),
      defineBackendTool<KeyValueDeleteRequest, KeyValueDeleteResponse>({
        id: "key_value.delete",
        title: "删除 Redis Key",
        description:
          "永久删除一个精确 Key。每次调用均按 critical destructive 风险展示连接、DB 和完整 Key，并要求强确认；不支持 prefix、pattern 或批量删除。",
        metadata: { category: "key_value", operation: "delete" },
        inputSchema: keyValueDeleteRequestSchema,
        outputSchema: keyValueDeleteResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["key_value_browser"],
        risk: {
          mode: "dynamic",
          level: "critical",
          reversible: false,
          sideEffect: "destructive",
        },
        prepare: { operation: "key_value.prepare_delete" },
        limits: {
          timeoutMs: 30_000,
          maxResultBytes: 256 * 1024,
        },
      }),
    ],
    resolveForRun: () => ({
      candidateToolIds: [
        "key_value.scan",
        "key_value.get",
        "key_value.create",
        "key_value.set",
        "key_value.rename",
        "key_value.set_ttl",
        "key_value.delete",
      ],
    }),
  };
}
