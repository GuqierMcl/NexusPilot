import {
  tableQueryRequestSchema,
  tableQueryResponseSchema,
  type TableQueryRequest,
  type TableQueryResponse,
} from "../backend-read-contracts";
import { defineBackendTool } from "../contracts";
import type { RuntimeToolNamespace } from "../kernel";

export function createTableToolNamespace(): RuntimeToolNamespace {
  return {
    id: "table",
    title: "Table Data",
    description:
      "通过结构化参数读取表、视图和物化视图的行数据，不接受 SQL 文本。",
    metadata: { capabilityModel: "data_table_browser" },
    tools: [
      defineBackendTool<TableQueryRequest, TableQueryResponse>({
        id: "table.query",
        title: "查询表数据",
        description:
          "使用 metadata.list_children 返回的 table、view 或 materialized_view container 查询行数据。只允许结构化列投影、固定枚举过滤、排序和分页；不得传入 SQL、表达式、函数、JOIN 或其他查询语言片段。多个过滤条件使用 AND 组合。",
        metadata: { category: "table", operation: "query" },
        inputSchema: tableQueryRequestSchema,
        outputSchema: tableQueryResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["data_table_browser"],
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
    resolveForRun: () => ({ candidateToolIds: ["table.query"] }),
  };
}
