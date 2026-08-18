import { aiRuntimeRequest } from "@/lib/ai-runtime/request";
import type { RunAgentMode } from "@/lib/ai-runtime/runs";

const AI_RUNTIME_AGENT_MODES_PATH = "/v1/agent-modes";

export type AgentModeCapability =
    | "question-answering"
    | "sql-explanation"
    | "runtime-tool-use"
    | "web-research"
    | string;

export interface AvailableAgentMode {
    agentMode: RunAgentMode;
    title: string;
    description: string;
    builtIn: boolean;
    capabilities: AgentModeCapability[];
}

interface RawAgentModeCatalogItem {
    agent_mode: RunAgentMode;
    title: string;
    description: string;
    built_in: boolean;
    capabilities: AgentModeCapability[];
}

interface AgentModeCatalogResponse {
    data: RawAgentModeCatalogItem[];
}

export async function listAgentModes(
    signal?: AbortSignal,
): Promise<AvailableAgentMode[]> {
    const response = await aiRuntimeRequest<AgentModeCatalogResponse>(
        AI_RUNTIME_AGENT_MODES_PATH,
        { signal, silent: true },
    );

    return response.data.map(toAvailableAgentMode);
}

function toAvailableAgentMode(
    raw: RawAgentModeCatalogItem,
): AvailableAgentMode {
    return {
        agentMode: raw.agent_mode,
        title: raw.title,
        description: raw.description,
        builtIn: raw.built_in,
        capabilities: raw.capabilities,
    };
}
