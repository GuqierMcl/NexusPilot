import {
  metadataDescribeTableRequestSchema,
  metadataDescribeTableResponseSchema,
  metadataListChildrenRequestSchema,
  metadataListChildrenResponseSchema,
  type MetadataDescribeTableRequest,
  type MetadataDescribeTableResponse,
  type MetadataListChildrenRequest,
  type MetadataListChildrenResponse,
} from "../backend-read-contracts";
import { defineBackendTool } from "../contracts";
import type { RuntimeToolNamespace } from "../kernel";

export function createMetadataToolNamespace(): RuntimeToolNamespace {
  return {
    id: "metadata",
    title: "Metadata",
    description:
      "按数据库能力读取已打开连接中的层级元数据和关系表结构。",
    metadata: { capabilityModel: "schema_browser" },
    tools: [
      defineBackendTool<
        MetadataListChildrenRequest,
        MetadataListChildrenResponse
      >({
        id: "metadata.list_children",
        title: "获取元数据子节点",
        description:
          "分页、逐层读取已打开连接的数据库对象。省略 parent 时读取根节点；继续展开时，必须把上一次响应中目标 children[].container 作为结构化对象原样传给 parent。不要把 parent 编码成 JSON 字符串，不要自行猜测或转换 kind。数据库、schema、asset_group、table 等层级由 Driver 返回，按返回结果逐层导航。本工具不会自动打开连接。",
        metadata: { category: "metadata", operation: "list_children" },
        inputSchema: metadataListChildrenRequestSchema,
        outputSchema: metadataListChildrenResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["schema_browser"],
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
      defineBackendTool<
        MetadataDescribeTableRequest,
        MetadataDescribeTableResponse
      >({
        id: "metadata.describe_table",
        title: "获取关系表结构",
        description:
          "读取已打开连接中一个 table ContainerRef 的列、索引和约束结构；不用于集合、键值或其他非关系型对象。",
        metadata: { category: "metadata", operation: "describe_table" },
        inputSchema: metadataDescribeTableRequestSchema,
        outputSchema: metadataDescribeTableResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["schema_browser"],
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
    ],
    resolveForRun: () => ({
      candidateToolIds: [
        "metadata.list_children",
        "metadata.describe_table",
      ],
    }),
  };
}
