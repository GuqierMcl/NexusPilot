export type RuntimeConnectAttempt = symbol;

const activeConnectAttempts = new Map<string, RuntimeConnectAttempt>();

export function beginRuntimeConnectAttempt(
    profileId: string,
): RuntimeConnectAttempt {
    const attempt = Symbol(profileId);
    activeConnectAttempts.set(profileId, attempt);
    return attempt;
}

export function cancelRuntimeConnectAttempt(profileId: string): void {
    activeConnectAttempts.delete(profileId);
}

export function finishRuntimeConnectAttempt(
    profileId: string,
    attempt: RuntimeConnectAttempt,
): boolean {
    if (activeConnectAttempts.get(profileId) !== attempt) {
        return false;
    }
    activeConnectAttempts.delete(profileId);
    return true;
}
