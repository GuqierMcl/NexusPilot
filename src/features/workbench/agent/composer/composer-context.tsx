import {
    createContext,
    useContext,
    useMemo,
    type FC,
    type PropsWithChildren,
} from "react";
import { useExplorerStore } from "@/store/slices/explorer-slice";
import { createWorkbenchComposerRegistry } from "./workbench-composer-registry";
import type { CommandRegistry, SourceRegistry } from "./composer-registry";

export interface ComposerRegistries {
    sources: SourceRegistry;
    commands: CommandRegistry;
}
const RegistryContext = createContext<ComposerRegistries | null>(null);
export const ComposerRegistryProvider = RegistryContext.Provider;
export function useComposerRegistries(): ComposerRegistries {
    const registry = useContext(RegistryContext);
    if (!registry) throw new Error("ComposerRegistryProvider is required");
    return registry;
}
export const WorkbenchComposerProvider: FC<PropsWithChildren> = ({
    children,
}) => {
    // Subscribe only to the directory, never to secrets on individual connection records.
    const connections = useExplorerStore((state) => state.connections);
    const isLoading = useExplorerStore((state) => state.isLoading);
    const error = useExplorerStore((state) => state.error);
    const refresh = useExplorerStore((state) => state.loadExplorerData);
    const registry = useMemo(
        () =>
            createWorkbenchComposerRegistry(() => ({
                connections: connections.map(({ id, name, driver }) => ({
                    id,
                    name,
                    driver,
                })),
                isLoading,
                error,
                refresh,
            })),
        [connections, isLoading, error, refresh],
    );
    return (
        <RegistryContext.Provider value={registry}>
            {children}
        </RegistryContext.Provider>
    );
};
