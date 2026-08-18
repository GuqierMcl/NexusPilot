import type { AvailableAgentMode } from "@/lib/ai-runtime/agent-modes";
import type { RunAgentMode } from "@/lib/ai-runtime/runs";

export const BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS: AvailableAgentMode[] = [
    {
        agentMode: "ask",
        title: "Ask",
        description: "问答与资料检索模式，不访问数据库连接或元数据。",
        builtIn: true,
        capabilities: ["question-answering", "web-research"],
    },
    {
        agentMode: "query",
        title: "Query",
        description: "数据库只读协作模式，可读取连接、元数据并完成受控只读任务。",
        builtIn: true,
        capabilities: [
            "question-answering",
            "web-research",
            "database-read",
            "runtime-tool-use",
        ],
    },
    {
        agentMode: "agent",
        title: "Agent",
        description: "完整受控智能体模式，可在权限流程下使用数据库操作工具。",
        builtIn: true,
        capabilities: [
            "question-answering",
            "web-research",
            "database-read",
            "runtime-tool-use",
        ],
    },
];

export function resolveAgentModeOptions(
    runtimeCatalog: AvailableAgentMode[] | undefined,
): AvailableAgentMode[] {
    return runtimeCatalog && runtimeCatalog.length > 0
        ? runtimeCatalog
        : BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS;
}

export function resolveSelectedAgentModeOption(
    options: AvailableAgentMode[],
    selectedAgentMode: RunAgentMode,
): AvailableAgentMode | null {
    return (
        options.find((option) => option.agentMode === selectedAgentMode) ??
        options.find((option) => option.agentMode === "ask") ??
        BUILT_IN_AGENT_MODE_FALLBACK_OPTIONS[0] ??
        null
    );
}
