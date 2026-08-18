import type { ReactNode } from "react";

import { AiRuntimeAvailabilityGate } from "@/components/ai-runtime-availability-gate";

interface AiRuntimeSettingsGateProps {
    children: ReactNode;
    preview: ReactNode;
    className?: string;
}

export function AiRuntimeSettingsGate({
    children,
    preview,
    className,
}: AiRuntimeSettingsGateProps) {
    return (
        <AiRuntimeAvailabilityGate preview={preview} className={className}>
            {children}
        </AiRuntimeAvailabilityGate>
    );
}
