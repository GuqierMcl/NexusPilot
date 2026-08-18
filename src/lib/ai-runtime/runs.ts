export const AI_RUNTIME_RUNS_PATH = "/v1/runs";

export function buildRunContinuePath(runId: string): string {
    return `${AI_RUNTIME_RUNS_PATH}/${encodeURIComponent(runId)}/continue`;
}

export function buildRunInterruptPath(runId: string): string {
    return `${AI_RUNTIME_RUNS_PATH}/${encodeURIComponent(runId)}/interrupt`;
}

export function buildConversationInterruptActiveRunPath(conversationId: string): string {
    return `/v1/conversations/${encodeURIComponent(conversationId)}/interrupt-active-run`;
}

export type RunResponseMode = "stream";

export type RunAgentMode = "ask" | "query" | "agent";

export interface RunModelSelection {
    providerId: string;
    modelId: string;
}

export interface RunCreateRequestModel {
    provider_id: string;
    model_id: string;
}

export interface RunCreateTextInputPart {
    type: "text";
    text: string;
}

export type RunCreateInputPart = RunCreateTextInputPart;

export interface RunCreateInput {
    parts: RunCreateInputPart[];
}

export interface RunCreateRequestMetadata {
    client_thread_id?: string;
    client_user_message_id?: string;
    request_trigger?: "submit-message" | "regenerate-message";
    request_message_id?: string;
}

export interface RunCreateRequest {
    response_mode: RunResponseMode;
    conversation_id?: string;
    replace_from_message_id?: string;
    model: RunCreateRequestModel;
    agent_mode?: RunAgentMode;
    input: RunCreateInput;
    metadata?: RunCreateRequestMetadata;
}

export interface RunPermissionResponse {
    permission_id: string;
    approved: boolean;
    confirmation_text?: string;
    reason?: string;
}

export interface RunContinueRequest {
    permission_responses: RunPermissionResponse[];
}

export type ToolRiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolPermissionSnapshot {
    id: string;
    run_id: string;
    message_id: string;
    tool_call_id: string;
    status: "pending" | "approved" | "denied" | "cancelled";
    tool_id: string;
    title: string;
    input_summary?: string;
    risk: {
        level: ToolRiskLevel;
        reversible: boolean;
        sideEffects: string[];
    };
    confirmation: {
        level: "standard" | "strong";
        prompt?: string;
    };
    presentation?: {
        target?: {
            profile_id?: string;
            connection_name?: string;
            driver?: string;
            environment?: string;
            database?: string;
            schema?: string;
            redis_db_index?: number;
        };
        risk_reasons?: string[];
        sql?: {
            text: string;
            analysis_status: "analyzed" | "uncertain" | "failed";
            statement_class?: string;
            identified_targets?: string[];
        };
        key_value?: {
            operation: "create" | "set" | "rename" | "set_ttl" | "delete";
            key: string;
            new_key?: string;
            value_type?: string;
            ttl_mode?: "keep" | "persist" | "expire";
            ttl_seconds?: number;
        };
        timeout_ms?: number;
        max_result_bytes?: number;
        outcome_warnings?: string[];
    };
    created_at: number;
}

export interface RunInterruptRequest {
    reason?: "user_stop" | "client_disconnect";
    message?: string;
    client_request_id?: string;
}

export interface RunInterruptResponse {
    run_id: string;
    conversation_id: string;
    status: string;
    interrupted: boolean;
    interrupt?: {
        reason?: string;
        message?: string;
        interrupted_at?: string;
    } | null;
}

export interface ConversationInterruptActiveRunResponse {
    conversation_id: string;
    run_id: string | null;
    interrupted: boolean;
    reason?: "no_active_run";
    status?: string;
}
