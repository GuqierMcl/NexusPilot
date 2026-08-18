import { createContext, useContext, type PropsWithChildren } from "react";

export interface AgentMessageEditController {
    beginEdit(messageId: string): void;
    cancelEdit(): void;
}

const AgentMessageEditContext = createContext<AgentMessageEditController | null>(
    null,
);

interface AgentMessageEditProviderProps extends PropsWithChildren {
    controller: AgentMessageEditController;
}

export function AgentMessageEditProvider({
    controller,
    children,
}: AgentMessageEditProviderProps) {
    return (
        <AgentMessageEditContext.Provider value={controller}>
            {children}
        </AgentMessageEditContext.Provider>
    );
}

export function useAgentMessageEditController(): AgentMessageEditController | null {
    return useContext(AgentMessageEditContext);
}
