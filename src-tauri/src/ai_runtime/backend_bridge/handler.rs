use async_trait::async_trait;
use serde_json::Value;

use super::frames::{GatewayError, GatewayExecutionContext};

pub type BackendBridgeHandlerResult = Result<Value, GatewayError>;

#[async_trait]
pub trait BackendBridgeRequestHandler: Send + Sync {
    async fn handle(&self, operation: &str, input: Value) -> BackendBridgeHandlerResult;

    async fn handle_with_context(
        &self,
        operation: &str,
        input: Value,
        _context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        self.handle(operation, input).await
    }

    fn on_disconnect(&self) {}
}
