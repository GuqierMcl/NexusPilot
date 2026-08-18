import {
  sqlExecuteRequestSchema,
  sqlExecuteResponseSchema,
  type SqlExecuteRequest,
  type SqlExecuteResponse,
} from "../sql-contracts";
import { defineBackendTool } from "../contracts";
import type { RuntimeToolNamespace } from "../kernel";

export function createSqlToolNamespace(): RuntimeToolNamespace {
  return {
    id: "sql",
    title: "Raw SQL",
    description:
      "对已打开的数据库连接执行一条经过后端分析、审批并绑定一次性计划的原始 SQL。",
    metadata: { capabilityModel: "sql_executor" },
    tools: [
      defineBackendTool<SqlExecuteRequest, SqlExecuteResponse>({
        id: "sql.execute",
        title: "执行 SQL",
        description:
          "在指定且已打开的连接上原样执行一条 SQL。模型负责按当前 Driver 生成正确方言；后端独立验证单语句边界、动态风险和目标能力。所有调用至少需要审批，无法精确分析的 SQL 会按 critical 强确认处理。",
        metadata: { category: "sql", operation: "execute" },
        inputSchema: sqlExecuteRequestSchema,
        outputSchema: sqlExecuteResponseSchema,
        executionTarget: "backend",
        requiredCapabilities: ["sql_executor"],
        risk: {
          mode: "dynamic",
          level: "medium",
          reversible: "conditional",
          sideEffect: "business_read",
        },
        prepare: { operation: "sql.analyze" },
        limits: {
          timeoutMs: 35_000,
          maxResultBytes: 1024 * 1024,
        },
      }),
    ],
    resolveForRun: () => ({ candidateToolIds: ["sql.execute"] }),
  };
}
