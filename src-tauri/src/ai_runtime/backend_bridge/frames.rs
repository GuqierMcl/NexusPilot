use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReadyFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub runtime_state: String,
    pub started_at: u64,
    pub heartbeat_interval_ms: u64,
    pub heartbeat_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PingFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub request_id: String,
    pub operation: String,
    pub input: Value,
    #[serde(default)]
    pub context: Option<GatewayExecutionContext>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayExecutionContext {
    pub conversation_id: String,
    pub run_id: String,
    pub message_id: String,
    pub tool_call_id: String,
    pub tool_id: String,
}

#[derive(Debug)]
pub enum RuntimeFrame {
    Ready(RuntimeReadyFrame),
    Ping(PingFrame),
    Request(RequestFrame),
}

#[derive(Clone, Debug, Serialize)]
pub struct GatewayError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub outcome: GatewayOutcome,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayOutcome {
    NotStarted,
    NoEffect,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum BackendFrame {
    #[serde(rename = "backend.ready")]
    Ready,
    #[serde(rename = "pong")]
    Pong { id: u64 },
    #[serde(rename = "response", rename_all = "camelCase")]
    SuccessResponse {
        request_id: String,
        ok: bool,
        data: Value,
    },
    #[serde(rename = "response", rename_all = "camelCase")]
    ErrorResponse {
        request_id: String,
        ok: bool,
        error: GatewayError,
    },
}

pub fn parse_runtime_frame(text: &str) -> Result<RuntimeFrame, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| "invalid_json".to_string())?;
    let frame_type = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing_frame_type".to_string())?;

    match frame_type {
        "runtime.ready" => serde_json::from_value(value)
            .map(RuntimeFrame::Ready)
            .map_err(|_| "invalid_runtime_ready".to_string()),
        "ping" => serde_json::from_value(value)
            .map(RuntimeFrame::Ping)
            .map_err(|_| "invalid_ping".to_string()),
        "request" => serde_json::from_value(value)
            .map(RuntimeFrame::Request)
            .map_err(|_| "invalid_request".to_string()),
        _ => Err("unknown_frame_type".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_runtime_frame, BackendFrame, GatewayError, GatewayOutcome, RuntimeFrame};

    #[test]
    fn parses_runtime_ready_and_serializes_backend_ready() {
        let frame = parse_runtime_frame(
            r#"{"type":"runtime.ready","runtimeState":"ready","startedAt":1,"heartbeatIntervalMs":15000,"heartbeatTimeoutMs":45000}"#,
        )
        .expect("runtime ready should parse");
        assert!(matches!(frame, RuntimeFrame::Ready(_)));
        assert_eq!(
            serde_json::to_string(&BackendFrame::Ready).expect("ready should serialize"),
            r#"{"type":"backend.ready"}"#
        );
    }

    #[test]
    fn rejects_unknown_and_extra_fields() {
        assert!(parse_runtime_frame(r#"{"type":"unknown"}"#).is_err());
        assert!(parse_runtime_frame(r#"{"type":"ping","id":1,"extra":true}"#).is_err());
    }

    #[test]
    fn parses_trusted_execution_context_separately_from_request_input() {
        let RuntimeFrame::Request(frame) = parse_runtime_frame(
            r#"{"type":"request","requestId":"req_1","operation":"sql.analyze","input":{"sql":"DELETE FROM users"},"context":{"conversationId":"conv_1","runId":"run_1","messageId":"msg_1","toolCallId":"tool_1","toolId":"sql.execute"}}"#,
        )
        .expect("request context should parse")
        else {
            panic!("expected request frame");
        };

        assert_eq!(frame.input["sql"], "DELETE FROM users");
        assert_eq!(
            frame.context.expect("context should exist").tool_call_id,
            "tool_1"
        );
    }

    #[test]
    fn serializes_success_and_error_responses_with_the_shared_response_type() {
        let success = BackendFrame::SuccessResponse {
            request_id: "req_1".to_string(),
            ok: true,
            data: serde_json::json!({"value": 1}),
        };
        let error = BackendFrame::ErrorResponse {
            request_id: "req_2".to_string(),
            ok: false,
            error: GatewayError {
                code: "GATEWAY_UNAVAILABLE".to_string(),
                message: "Unavailable".to_string(),
                retryable: false,
                outcome: GatewayOutcome::NotStarted,
            },
        };

        assert_eq!(
            serde_json::to_value(success).expect("success should serialize")["type"],
            "response"
        );
        assert_eq!(
            serde_json::to_value(error).expect("error should serialize")["type"],
            "response"
        );
    }
}
