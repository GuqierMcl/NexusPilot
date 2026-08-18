use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use crate::ai_runtime::endpoint::AiRuntimeEndpoint;

use super::frames::{parse_runtime_frame, BackendFrame, RuntimeFrame};
use super::handler::BackendBridgeRequestHandler;

const BACKEND_BRIDGE_PATH: &str = "/v1/internal/backend-bridge";
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_millis(250);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(5);

pub struct BackendBridgeClientHandle {
    shutdown_tx: watch::Sender<bool>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl BackendBridgeClientHandle {
    pub fn shutdown(&mut self) {
        let _ = self.shutdown_tx.send(true);
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

impl Drop for BackendBridgeClientHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn spawn_backend_bridge_client(
    endpoint: AiRuntimeEndpoint,
    handler: Arc<dyn BackendBridgeRequestHandler>,
) -> BackendBridgeClientHandle {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let task = tauri::async_runtime::spawn(run_reconnect_loop(endpoint, handler, shutdown_rx));
    BackendBridgeClientHandle {
        shutdown_tx,
        task: Some(task),
    }
}

async fn run_reconnect_loop(
    endpoint: AiRuntimeEndpoint,
    handler: Arc<dyn BackendBridgeRequestHandler>,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut delay = INITIAL_RECONNECT_DELAY;
    loop {
        if *shutdown_rx.borrow() {
            return;
        }

        let connection_result = connect(&endpoint, handler.clone(), shutdown_rx.clone()).await;
        if matches!(&connection_result, Ok(true)) {
            delay = INITIAL_RECONNECT_DELAY;
        } else if let Err(error) = &connection_result {
            tauri_plugin_log::log::debug!(
                "AI Runtime Backend Bridge connection ended: reason={error}"
            );
        }

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() { return; }
            }
        }
        delay = (delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

async fn connect(
    endpoint: &AiRuntimeEndpoint,
    handler: Arc<dyn BackendBridgeRequestHandler>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<bool, String> {
    let url = format!(
        "ws://{}:{}{}",
        endpoint.host, endpoint.port, BACKEND_BRIDGE_PATH
    );
    let mut request = url
        .into_client_request()
        .map_err(|_| "invalid_bridge_endpoint".to_string())?;
    if let Some(token) = endpoint.access_token.as_deref() {
        let value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "invalid_bridge_credential".to_string())?;
        request.headers_mut().insert(AUTHORIZATION, value);
    }

    let (stream, _) = tokio::select! {
        result = connect_async(request) => result.map_err(|_| "bridge_connect_failed".to_string())?,
        changed = shutdown_rx.changed() => {
            let _ = changed;
            return Ok(false);
        }
    };
    run_connection(stream, handler, shutdown_rx).await
}

async fn run_connection<S>(
    stream: tokio_tungstenite::WebSocketStream<S>,
    handler: Arc<dyn BackendBridgeRequestHandler>,
    mut shutdown_rx: watch::Receiver<bool>,
) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut source) = stream.split();
    let (write_tx, mut write_rx) = mpsc::channel::<BackendFrame>(32);
    let writer = tokio::spawn(async move {
        while let Some(frame) = write_rx.recv().await {
            let text = serde_json::to_string(&frame).map_err(|_| "serialize_frame")?;
            log_sent_frame(&frame, text.len());
            sink.send(Message::Text(text.into()))
                .await
                .map_err(|_| "write_frame")?;
        }
        Result::<(), &'static str>::Ok(())
    });

    let mut ready = false;
    let result = loop {
        tokio::select! {
            changed = shutdown_rx.changed() => {
                let _ = changed;
                break Ok(ready);
            }
            message = source.next() => {
                let Some(message) = message else { break Ok(ready); };
                let message = message.map_err(|_| "read_frame".to_string())?;
                let text = match message {
                    Message::Text(text) => text,
                    Message::Close(_) => break Ok(ready),
                    _ => break Err("unsupported_frame".to_string()),
                };
                let frame = parse_runtime_frame(&text)?;
                log_received_frame(&frame, text.len());
                match frame {
                    RuntimeFrame::Ready(frame) if !ready => {
                        if frame.frame_type != "runtime.ready"
                            || frame.runtime_state != "ready"
                            || frame.heartbeat_interval_ms == 0
                            || frame.heartbeat_timeout_ms < frame.heartbeat_interval_ms
                        {
                            break Err("invalid_runtime_ready".to_string());
                        }
                        let _ = frame.started_at;
                        write_tx.send(BackendFrame::Ready).await.map_err(|_| "writer_closed".to_string())?;
                        ready = true;
                    }
                    RuntimeFrame::Ready(_) => break Err("duplicate_runtime_ready".to_string()),
                    RuntimeFrame::Ping(frame) if ready => {
                        if frame.frame_type != "ping" { break Err("invalid_ping".to_string()); }
                        write_tx.send(BackendFrame::Pong { id: frame.id }).await.map_err(|_| "writer_closed".to_string())?;
                    }
                    RuntimeFrame::Request(frame) if ready => {
                        if frame.frame_type != "request" || frame.request_id.is_empty() || frame.operation.is_empty() {
                            break Err("invalid_request".to_string());
                        }
                        let tx = write_tx.clone();
                        let handler = handler.clone();
                        tokio::spawn(async move {
                            let response = match handler
                                .handle_with_context(
                                    &frame.operation,
                                    frame.input,
                                    frame.context,
                                )
                                .await
                            {
                                Ok(data) => BackendFrame::SuccessResponse {
                                    request_id: frame.request_id,
                                    ok: true,
                                    data,
                                },
                                Err(error) => BackendFrame::ErrorResponse {
                                    request_id: frame.request_id,
                                    ok: false,
                                    error,
                                },
                            };
                            let _ = tx.send(response).await;
                        });
                    }
                    RuntimeFrame::Ping(_) | RuntimeFrame::Request(_) => {
                        break Err("runtime_ready_required".to_string());
                    }
                }
            }
        }
    };

    drop(write_tx);
    writer.abort();
    handler.on_disconnect();
    result
}

fn log_sent_frame(frame: &BackendFrame, byte_length: usize) {
    match frame {
        BackendFrame::Ready => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=send frame_type=backend.ready byte_length={byte_length}"
        ),
        BackendFrame::Pong { id } => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=send frame_type=pong frame_id={id} byte_length={byte_length}"
        ),
        BackendFrame::SuccessResponse { request_id, .. } => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=send frame_type=response request_id={} ok=true byte_length={byte_length}",
            bounded_log_value(request_id)
        ),
        BackendFrame::ErrorResponse {
            request_id, error, ..
        } => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=send frame_type=response request_id={} ok=false error_code={} byte_length={byte_length}",
            bounded_log_value(request_id),
            bounded_log_value(&error.code)
        ),
    }
}

fn log_received_frame(frame: &RuntimeFrame, byte_length: usize) {
    match frame {
        RuntimeFrame::Ready(_) => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=receive frame_type=runtime.ready byte_length={byte_length}"
        ),
        RuntimeFrame::Ping(frame) => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=receive frame_type=ping frame_id={} byte_length={byte_length}",
            frame.id
        ),
        RuntimeFrame::Request(frame) => tauri_plugin_log::log::debug!(
            "AI Runtime Backend Bridge frame: direction=receive frame_type=request request_id={} operation={} byte_length={byte_length}",
            bounded_log_value(&frame.request_id),
            bounded_log_value(&frame.operation)
        ),
    }
}

fn bounded_log_value(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '?'
            } else {
                character
            }
        })
        .take(128)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio::sync::{oneshot, watch};
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::Message;

    use crate::ai_runtime::endpoint::{AiRuntimeEndpoint, AiRuntimeMode};

    use super::{connect, run_reconnect_loop};
    use crate::ai_runtime::backend_bridge::GatewayDispatcher;

    #[test]
    fn authenticates_and_completes_ready_ping_and_placeholder_request_flow() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("test listener should bind");
            let port = listener
                .local_addr()
                .expect("listener should have address")
                .port();
            let authorization = Arc::new(Mutex::new(None::<String>));
            let observed_authorization = authorization.clone();

            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.expect("client should connect");
                let mut websocket =
                    accept_hdr_async(stream, move |request: &Request, response: Response| {
                        *observed_authorization.lock().expect("header lock") = request
                            .headers()
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_string);
                        Ok(response)
                    })
                    .await
                    .expect("upgrade should succeed");

                websocket
                    .send(Message::Text(
                        r#"{"type":"runtime.ready","runtimeState":"ready","startedAt":1,"heartbeatIntervalMs":15000,"heartbeatTimeoutMs":45000}"#
                            .into(),
                    ))
                    .await
                    .expect("runtime ready should send");
                let ready = websocket
                    .next()
                    .await
                    .expect("backend ready frame")
                    .expect("valid frame");

                websocket
                    .send(Message::Text(r#"{"type":"ping","id":7}"#.into()))
                    .await
                    .expect("ping should send");
                let pong = websocket
                    .next()
                    .await
                    .expect("pong frame")
                    .expect("valid frame");

                websocket
                    .send(Message::Text(
                        r#"{"type":"request","requestId":"req_1","operation":"connection.list","input":{}}"#
                            .into(),
                    ))
                    .await
                    .expect("request should send");
                let response = websocket
                    .next()
                    .await
                    .expect("response frame")
                    .expect("valid frame");
                websocket.close(None).await.expect("server should close");

                (ready, pong, response)
            });

            let endpoint = AiRuntimeEndpoint::new(
                "127.0.0.1",
                port,
                AiRuntimeMode::Production,
                Some("bridge-test-token".to_string()),
            );
            let (_shutdown_tx, shutdown_rx) = watch::channel(false);
            let was_ready = connect(&endpoint, Arc::new(GatewayDispatcher::empty()), shutdown_rx)
                .await
                .expect("client flow should succeed");
            assert!(was_ready);

            let (ready, pong, response) = server.await.expect("server task should finish");
            assert_eq!(
                authorization.lock().expect("header lock").as_deref(),
                Some("Bearer bridge-test-token")
            );
            assert_eq!(
                ready.into_text().expect("ready should be text"),
                r#"{"type":"backend.ready"}"#
            );
            assert_eq!(
                pong.into_text().expect("pong should be text"),
                r#"{"type":"pong","id":7}"#
            );
            let response: serde_json::Value =
                serde_json::from_str(&response.into_text().expect("response should be text"))
                    .expect("response should be json");
            assert_eq!(response["type"], "response");
            assert_eq!(response["requestId"], "req_1");
            assert_eq!(response["ok"], false);
            assert_eq!(response["error"]["code"], "GATEWAY_OPERATION_NOT_FOUND");
        });
    }

    #[test]
    fn reconnects_after_a_ready_connection_is_closed() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .expect("test listener should bind");
            let port = listener
                .local_addr()
                .expect("listener should have address")
                .port();
            let (second_ready_tx, second_ready_rx) = oneshot::channel();

            let server = tokio::spawn(async move {
                let mut second_ready_tx = Some(second_ready_tx);
                for connection_index in 0..2 {
                    let (stream, _) = listener.accept().await.expect("client should reconnect");
                    let mut websocket = tokio_tungstenite::accept_async(stream)
                        .await
                        .expect("upgrade should succeed");
                    websocket
                        .send(Message::Text(
                            r#"{"type":"runtime.ready","runtimeState":"ready","startedAt":1,"heartbeatIntervalMs":15000,"heartbeatTimeoutMs":45000}"#
                                .into(),
                        ))
                        .await
                        .expect("runtime ready should send");
                    let ready = websocket
                        .next()
                        .await
                        .expect("backend ready")
                        .expect("valid frame");
                    assert_eq!(
                        ready.into_text().expect("ready should be text"),
                        r#"{"type":"backend.ready"}"#
                    );

                    if connection_index == 0 {
                        websocket
                            .close(None)
                            .await
                            .expect("first connection should close");
                    } else {
                        second_ready_tx
                            .take()
                            .expect("signal should exist")
                            .send(())
                            .ok();
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
            });

            let endpoint =
                AiRuntimeEndpoint::new("127.0.0.1", port, AiRuntimeMode::Development, None);
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            let reconnect = tokio::spawn(run_reconnect_loop(
                endpoint,
                Arc::new(GatewayDispatcher::empty()),
                shutdown_rx,
            ));

            tokio::time::timeout(Duration::from_secs(3), second_ready_rx)
                .await
                .expect("second connection should become ready")
                .expect("ready signal should send");
            shutdown_tx.send(true).expect("shutdown should send");
            reconnect.await.expect("reconnect loop should stop");
            server.abort();
        });
    }

    #[test]
    #[ignore = "manual cross-process test; requires a running authenticated AI Runtime"]
    fn connects_to_a_real_ai_runtime_process() {
        tauri::async_runtime::block_on(async {
            let port = std::env::var("NEXUS_PILOT_BRIDGE_TEST_PORT")
                .expect("test port must be set")
                .parse::<u16>()
                .expect("test port must be valid");
            let token =
                std::env::var("NEXUS_PILOT_BRIDGE_TEST_TOKEN").expect("test token must be set");
            let endpoint =
                AiRuntimeEndpoint::new("127.0.0.1", port, AiRuntimeMode::Production, Some(token));
            let (shutdown_tx, shutdown_rx) = watch::channel(false);
            let connection = tokio::spawn(async move {
                connect(&endpoint, Arc::new(GatewayDispatcher::empty()), shutdown_rx).await
            });

            let client = reqwest::Client::new();
            let mut observed_ready = false;
            for _ in 0..50 {
                if let Ok(response) = client
                    .get(format!("http://127.0.0.1:{port}/health"))
                    .send()
                    .await
                {
                    if let Ok(text) = response.text().await {
                        if let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) {
                            observed_ready = body["data"]["backendBridge"]["state"] == "ready";
                            if observed_ready {
                                break;
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }

            shutdown_tx.send(true).expect("shutdown should send");
            let was_ready = connection
                .await
                .expect("connection task should finish")
                .expect("real Runtime connection should succeed");
            assert!(observed_ready);
            assert!(was_ready);
        });
    }
}
