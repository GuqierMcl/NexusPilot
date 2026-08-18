import { Elysia, type DocumentDecoration } from "elysia";
import {
  BuiltInAgentDefinitionRegistry,
  type AgentDefinition,
} from "../runtime/agents/agent-definition";
import type { OpenApiSchema } from "./openapi";

type OpenApiResponses = NonNullable<DocumentDecoration["responses"]>;

export interface AgentModeCatalogItem {
  agent_mode: AgentDefinition["agentMode"];
  title: string;
  description: string;
  built_in: true;
  capabilities: AgentDefinition["capabilities"];
}

export function agentModeRoutes() {
  const registry = new BuiltInAgentDefinitionRegistry();

  return new Elysia({ prefix: "/v1", name: "agent-mode-routes" })
    .get("/agent-modes", () => ({
      data: registry.list().map(serializeAgentModeCatalogItem),
    }), {
      detail: {
        tags: ["智能体模式"],
        summary: "列出内置 Agent Mode",
        description:
          "返回 AI Runtime 当前内置 agent mode 的只读 UI catalog。该接口不暴露 system prompt、limits、tool policy 或其它内部运行策略。",
        responses: agentModeCatalogResponses,
      },
    });
}

function serializeAgentModeCatalogItem(
  definition: AgentDefinition,
): AgentModeCatalogItem {
  return {
    agent_mode: definition.agentMode,
    title: definition.title,
    description: definition.description,
    built_in: definition.builtIn,
    capabilities: definition.capabilities,
  };
}

const agentModeCatalogItemSchema: OpenApiSchema = {
  type: "object",
  required: ["agent_mode", "title", "description", "built_in", "capabilities"],
  properties: {
    agent_mode: {
      type: "string",
      enum: ["ask", "query", "agent"],
      description: "公开 Run 请求中的 agent_mode 值。",
    },
    title: {
      type: "string",
      description: "适合 UI 展示的 agent mode 名称。",
    },
    description: {
      type: "string",
      description: "适合 UI 展示的 agent mode 简短说明。",
    },
    built_in: {
      type: "boolean",
      description: "是否为 Runtime 内置模式。第一版恒为 true。",
    },
    capabilities: {
      type: "array",
      description: "公开能力标签，仅用于 UI 辅助展示，不等同于 tool policy。",
      items: {
        type: "string",
      },
    },
  },
};

const agentModeCatalogResponseSchema: OpenApiSchema = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      type: "array",
      items: agentModeCatalogItemSchema,
    },
  },
};

const agentModeCatalogResponses = {
  200: {
    description: "Agent mode catalog。",
    content: {
      "application/json": {
        schema: agentModeCatalogResponseSchema,
      },
    },
  },
} as OpenApiResponses;
