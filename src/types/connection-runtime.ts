import type {
    ConnectionRuntimeInfo,
    DriverCapabilities,
} from "@/types/ipc";

/** 产品层数据库运行时会话生命周期；不表示某条 socket 是否常驻。 */
export type ConnectionStatus =
    | "idle"
    | "connecting"
    | "connected"
    | "degraded"
    | "reconnecting"
    | "error"
    | "disconnecting";

export interface RuntimeRecoveryState {
    attempt: number;
    maxAttempts: number;
    lastFailureAt?: number;
}

export interface ISessionState {
    status: ConnectionStatus;
    ping?: number;
    errorMsg?: string;
    activeDatabase?: string;
    capabilities?: DriverCapabilities;
    recovery?: RuntimeRecoveryState;
}

export type RuntimeSessionEvent =
    | { type: "connectRequested" }
    | {
          type: "connectSucceeded";
          runtime: ConnectionRuntimeInfo;
          ping?: number;
      }
    | { type: "connectFailed"; message: string }
    | {
          type: "retryableFailure";
          message: string;
          occurredAt: number;
      }
    | { type: "terminalFailure"; message: string }
    | {
          type: "reconnectStarted";
          attempt: number;
          maxAttempts: number;
      }
    | {
          type: "probeSucceeded";
          ping: number;
      }
    | {
          type: "probeFailed";
          attempt: number;
          maxAttempts: number;
          message: string;
          occurredAt: number;
      }
    | { type: "disconnectRequested" }
    | { type: "disconnectFinished" }
    | { type: "activeDatabaseChanged"; database: string };

export type ConnectionMetadataAction =
    | "connect"
    | "load"
    | "unsupported"
    | "wait";
