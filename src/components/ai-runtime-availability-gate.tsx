import type { ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { getAiRuntimeAvailabilityOverlay } from "@/features/workbench/agent/state";
import { cn } from "@/lib/utils";
import { useAiRuntimeEndpointStore } from "@/store/slices/ai-runtime-endpoint-slice";

interface AiRuntimeAvailabilityGateProps {
    children: ReactNode;
    preview: ReactNode;
    className?: string;
}

export function AiRuntimeAvailabilityGate({
    children,
    preview,
    className,
}: AiRuntimeAvailabilityGateProps) {
    const endpoint = useAiRuntimeEndpointStore((s) => s.endpoint);
    const healthStatus = useAiRuntimeEndpointStore((s) => s.healthStatus);
    const isChecking = useAiRuntimeEndpointStore((s) => s.isChecking);
    const errorMessage = useAiRuntimeEndpointStore((s) => s.errorMessage);
    const overlay = getAiRuntimeAvailabilityOverlay({
        endpointKnown: endpoint !== null,
        healthStatus,
        isChecking,
        errorMessage,
    });

    if (!overlay) {
        return children;
    }

    return (
        <div className={cn("relative min-h-[420px]", className)}>
            <div className="pointer-events-none select-none blur-[2px]">
                {preview}
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-background/45 px-8">
                <Alert className="max-w-md bg-background shadow-sm">
                    {isChecking ? <Spinner /> : <CircleAlertIcon />}
                    <AlertTitle>{overlay.title}</AlertTitle>
                    <AlertDescription>{overlay.description}</AlertDescription>
                </Alert>
            </div>
        </div>
    );
}
