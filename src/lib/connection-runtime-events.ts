import type {
    ErrorCode,
    IAppError,
    RuntimeErrorImpact,
} from "@/types/ipc";

export interface RuntimeFailureEvent {
    profileId: string;
    code: ErrorCode;
    runtimeImpact: Exclude<RuntimeErrorImpact, "businessOnly">;
    message: string;
    command: string;
    occurredAt: number;
}

type RuntimeFailureListener = (event: RuntimeFailureEvent) => void;

const listeners = new Set<RuntimeFailureListener>();

export function toRuntimeFailureEvent(
    command: string,
    args: Record<string, unknown> | undefined,
    error: IAppError,
    occurredAt: number,
): RuntimeFailureEvent | null {
    const profileId = args?.profileId;
    if (
        typeof profileId !== "string" ||
        (error.runtimeImpact !== "retryable" &&
            error.runtimeImpact !== "terminal")
    ) {
        return null;
    }

    return {
        profileId,
        code: error.code,
        runtimeImpact: error.runtimeImpact,
        message: error.message,
        command,
        occurredAt,
    };
}

export function publishRuntimeFailure(event: RuntimeFailureEvent): void {
    for (const listener of listeners) {
        listener(event);
    }
}

export function subscribeRuntimeFailure(
    listener: RuntimeFailureListener,
): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
