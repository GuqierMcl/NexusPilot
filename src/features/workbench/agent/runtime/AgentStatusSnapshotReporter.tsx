import { useAuiState } from "@assistant-ui/react";
import { useEffect, type FC } from "react";

import {
    useAgentComposerSendBlocker,
    useAgentStatusSnapshotStore,
} from "../state";

/**
 * Publishes the assistant-ui-derived send blocker without exposing the
 * assistant runtime outside the Agent panel.
 */
export const AgentStatusSnapshotReporter: FC = () => {
    const composerSendBlocker = useAgentComposerSendBlocker();
    const isTransportActive = useAuiState((state) => state.thread.isRunning);
    const setComposerSendBlocker = useAgentStatusSnapshotStore(
        (state) => state.setComposerSendBlocker,
    );
    const setActiveRunTransportActive = useAgentStatusSnapshotStore(
        (state) => state.setActiveRunTransportActive,
    );
    const clearActiveRunCloseSnapshot = useAgentStatusSnapshotStore(
        (state) => state.clearActiveRunCloseSnapshot,
    );

    useEffect(() => {
        setComposerSendBlocker(composerSendBlocker);
    }, [composerSendBlocker, setComposerSendBlocker]);

    useEffect(() => {
        setActiveRunTransportActive(isTransportActive);
    }, [isTransportActive, setActiveRunTransportActive]);

    useEffect(
        () => () => {
            setComposerSendBlocker(null);
            clearActiveRunCloseSnapshot();
        },
        [clearActiveRunCloseSnapshot, setComposerSendBlocker],
    );

    return null;
};
