import type { AgentMode, RunLimits } from "../core/types";
import type { ToolRiskLevel, ToolSideEffect } from "../tools/contracts";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent";
import { ASK_SYSTEM_PROMPT } from "./prompts/ask";
import { QUERY_SYSTEM_PROMPT } from "./prompts/query";

export type AgentCapability =
  | "question-answering"
  | "sql-explanation"
  | "database-read"
  | "runtime-tool-use"
  | "web-research";

export interface AgentToolPolicy {
  allowedNamespaces: string[];
  allowedTools?: string[];
  deniedTools?: string[];
  executionCeiling: {
    maxRiskLevel: ToolRiskLevel;
    allowedSideEffects: ToolSideEffect[];
    allowIrreversible: boolean;
  };
}

export interface AgentModelBehavior {
  temperature?: number;
  topP?: number;
  toolChoice?: "auto" | "none";
}

export interface AgentDefinition {
  id: string;
  agentMode: AgentMode;
  title: string;
  description: string;
  builtIn: true;
  systemPrompt: string;
  capabilities: AgentCapability[];
  toolPolicy: AgentToolPolicy;
  limits: RunLimits;
  modelBehavior: AgentModelBehavior;
  metadata: {
    version: string;
    source: "builtin";
    risk: "low" | "medium";
  };
}

const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 50,
  maxToolCalls: 300,
};

export const BUILT_IN_AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "ask",
    agentMode: "ask",
    title: "Ask",
    description:
      "问答与公开资料检索模式，不访问数据库连接、元数据或内容。",
    builtIn: true,
    systemPrompt: ASK_SYSTEM_PROMPT,
    capabilities: ["question-answering", "sql-explanation", "web-research"],
    toolPolicy: {
      allowedNamespaces: ["system", "web"],
      executionCeiling: {
        maxRiskLevel: "low",
        allowedSideEffects: ["none", "external_network"],
        allowIrreversible: false,
      },
    },
    limits: DEFAULT_LIMITS,
    modelBehavior: {
      temperature: 0.2,
      toolChoice: "auto",
    },
    metadata: {
      version: "1",
      source: "builtin",
      risk: "low",
    },
  },
  {
    id: "query",
    agentMode: "query",
    title: "Query",
    description:
      "数据库只读协作模式，可发现连接、读取元数据并完成受控只读任务。",
    builtIn: true,
    systemPrompt: QUERY_SYSTEM_PROMPT,
    capabilities: [
      "question-answering",
      "sql-explanation",
      "database-read",
      "runtime-tool-use",
      "web-research",
    ],
    toolPolicy: {
      allowedNamespaces: [
        "system",
        "web",
        "connection",
        "metadata",
        "table",
        "key_value",
      ],
      executionCeiling: {
        maxRiskLevel: "medium",
        allowedSideEffects: [
          "none",
          "external_network",
          "runtime_state",
          "workbench_state",
          "business_read",
        ],
        allowIrreversible: false,
      },
    },
    limits: DEFAULT_LIMITS,
    modelBehavior: {
      temperature: 0.2,
      toolChoice: "auto",
    },
    metadata: {
      version: "1",
      source: "builtin",
      risk: "low",
    },
  },
  {
    id: "agent",
    agentMode: "agent",
    title: "Agent",
    description:
      "完整受控智能体模式，可在权限流程下使用数据库操作工具。",
    builtIn: true,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    capabilities: [
      "question-answering",
      "sql-explanation",
      "database-read",
      "runtime-tool-use",
      "web-research",
    ],
    toolPolicy: {
      allowedNamespaces: [
        "system",
        "web",
        "connection",
        "metadata",
        "table",
        "key_value",
        "sql",
      ],
      executionCeiling: {
        maxRiskLevel: "critical",
        allowedSideEffects: [
          "none",
          "external_network",
          "runtime_state",
          "workbench_state",
          "business_read",
          "business_write",
          "destructive",
        ],
        allowIrreversible: true,
      },
    },
    limits: DEFAULT_LIMITS,
    modelBehavior: {
      temperature: 0.2,
      toolChoice: "auto",
    },
    metadata: {
      version: "1",
      source: "builtin",
      risk: "medium",
    },
  },
];

export class BuiltInAgentDefinitionRegistry {
  private readonly definitions = new Map<AgentMode, AgentDefinition>();

  constructor(definitions: AgentDefinition[] = BUILT_IN_AGENT_DEFINITIONS) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.agentMode)) {
        throw new Error(`Duplicate agent mode: ${definition.agentMode}`);
      }

      this.definitions.set(definition.agentMode, cloneAgentDefinition(definition));
    }
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()].map(cloneAgentDefinition);
  }

  get(agentMode: AgentMode): AgentDefinition | null {
    const definition = this.definitions.get(agentMode);
    return definition ? cloneAgentDefinition(definition) : null;
  }

  require(agentMode: AgentMode): AgentDefinition {
    const definition = this.get(agentMode);
    if (!definition) {
      throw new Error(`Unknown agent mode: ${agentMode}`);
    }

    return definition;
  }
}

export function cloneAgentDefinition(definition: AgentDefinition): AgentDefinition {
  return {
    ...definition,
    capabilities: [...definition.capabilities],
    toolPolicy: {
      ...definition.toolPolicy,
      allowedNamespaces: [...definition.toolPolicy.allowedNamespaces],
      ...(definition.toolPolicy.allowedTools
        ? { allowedTools: [...definition.toolPolicy.allowedTools] }
        : {}),
      ...(definition.toolPolicy.deniedTools
        ? { deniedTools: [...definition.toolPolicy.deniedTools] }
        : {}),
      executionCeiling: {
        ...definition.toolPolicy.executionCeiling,
        allowedSideEffects: [
          ...definition.toolPolicy.executionCeiling.allowedSideEffects,
        ],
      },
    },
    limits: { ...definition.limits },
    modelBehavior: { ...definition.modelBehavior },
    metadata: { ...definition.metadata },
  };
}
