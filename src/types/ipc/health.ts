export interface PingResult {
    latencyMs: number;
}

export interface ConnectionTestResult {
    latencyMs: number;
    driverName: string;
    endpoint: string;
    serverVersion?: string | null;
    sshHostKeyFingerprint?: string | null;
}
