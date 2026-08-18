use std::collections::BTreeMap;
use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::FutureExt;
use serde_json::Value;

use super::frames::{GatewayError, GatewayExecutionContext, GatewayOutcome};
use super::handler::{BackendBridgeHandlerResult, BackendBridgeRequestHandler};
use super::prepared_plans::PreparedPlanRegistry;

#[async_trait]
pub trait GatewayOperation: Send + Sync {
    fn id(&self) -> &'static str;

    async fn execute(&self, input: Value) -> BackendBridgeHandlerResult;

    async fn execute_with_context(
        &self,
        input: Value,
        _context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        self.execute(input).await
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum GatewayRegistryError {
    InvalidOperationId(String),
    DuplicateOperation(String),
}

pub struct GatewayDispatcher {
    operations: BTreeMap<&'static str, Arc<dyn GatewayOperation>>,
    prepared_plans: Option<PreparedPlanRegistry>,
}

impl GatewayDispatcher {
    pub fn new(
        operations: impl IntoIterator<Item = Arc<dyn GatewayOperation>>,
    ) -> Result<Self, GatewayRegistryError> {
        let mut registry = BTreeMap::new();
        for operation in operations {
            let operation_id = operation.id();
            if !is_canonical_operation_id(operation_id) {
                return Err(GatewayRegistryError::InvalidOperationId(
                    operation_id.to_string(),
                ));
            }
            if registry.insert(operation_id, operation).is_some() {
                return Err(GatewayRegistryError::DuplicateOperation(
                    operation_id.to_string(),
                ));
            }
        }
        Ok(Self {
            operations: registry,
            prepared_plans: None,
        })
    }

    pub fn with_prepared_plans(mut self, prepared_plans: PreparedPlanRegistry) -> Self {
        self.prepared_plans = Some(prepared_plans);
        self
    }

    #[cfg(test)]
    pub fn empty() -> Self {
        Self {
            operations: BTreeMap::new(),
            prepared_plans: None,
        }
    }

    #[cfg(test)]
    fn operation_ids(&self) -> Vec<&'static str> {
        self.operations.keys().copied().collect()
    }
}

#[async_trait]
impl BackendBridgeRequestHandler for GatewayDispatcher {
    async fn handle(&self, operation: &str, input: Value) -> BackendBridgeHandlerResult {
        self.dispatch(operation, input, None).await
    }

    async fn handle_with_context(
        &self,
        operation: &str,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        self.dispatch(operation, input, context).await
    }

    fn on_disconnect(&self) {
        if let Some(prepared_plans) = &self.prepared_plans {
            prepared_plans.clear_all();
        }
    }
}

impl GatewayDispatcher {
    async fn dispatch(
        &self,
        operation: &str,
        input: Value,
        context: Option<GatewayExecutionContext>,
    ) -> BackendBridgeHandlerResult {
        let Some(handler) = self.operations.get(operation).cloned() else {
            return Err(GatewayError::operation_not_found());
        };

        match AssertUnwindSafe(handler.execute_with_context(input, context))
            .catch_unwind()
            .await
        {
            Ok(result) => result,
            Err(_) => {
                tauri_plugin_log::log::error!(
                    "AI Runtime Gateway operation panicked: operation={}",
                    bounded_log_value(operation)
                );
                Err(GatewayError::system_internal())
            }
        }
    }
}

impl GatewayError {
    pub fn operation_not_found() -> Self {
        Self {
            code: "GATEWAY_OPERATION_NOT_FOUND".to_string(),
            message: "Backend Gateway operation is not registered.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::NotStarted,
        }
    }

    pub fn system_internal() -> Self {
        Self {
            code: "SYSTEM_INTERNAL".to_string(),
            message: "Backend Gateway operation failed.".to_string(),
            retryable: false,
            outcome: GatewayOutcome::Unknown,
        }
    }
}

fn is_canonical_operation_id(value: &str) -> bool {
    let mut segments = value.split('.');
    let Some(namespace) = segments.next() else {
        return false;
    };
    let Some(operation) = segments.next() else {
        return false;
    };
    segments.next().is_none()
        && is_lower_snake_segment(namespace)
        && is_lower_snake_segment(operation)
}

fn is_lower_snake_segment(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_lowercase() {
        return false;
    }
    let mut previous_underscore = false;
    for byte in bytes {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
            previous_underscore = false;
        } else if *byte == b'_' && !previous_underscore {
            previous_underscore = true;
        } else {
            return false;
        }
    }
    !previous_underscore
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
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde::Deserialize;
    use serde_json::{json, Value};

    use super::{
        BackendBridgeHandlerResult, BackendBridgeRequestHandler, GatewayDispatcher, GatewayError,
        GatewayOperation, GatewayRegistryError,
    };

    struct EchoOperation {
        id: &'static str,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct EchoInput {
        value: String,
    }

    #[async_trait]
    impl GatewayOperation for EchoOperation {
        fn id(&self) -> &'static str {
            self.id
        }

        async fn execute(&self, input: Value) -> BackendBridgeHandlerResult {
            let input: EchoInput = serde_json::from_value(input).map_err(|_| GatewayError {
                code: "GATEWAY_INVALID_REQUEST".to_string(),
                message: "Invalid echo request.".to_string(),
                retryable: false,
                outcome: super::GatewayOutcome::NotStarted,
            })?;
            Ok(json!({ "value": input.value }))
        }
    }

    struct PanicOperation;

    #[async_trait]
    impl GatewayOperation for PanicOperation {
        fn id(&self) -> &'static str {
            "test.panic"
        }

        async fn execute(&self, _input: Value) -> BackendBridgeHandlerResult {
            panic!("secret panic detail");
        }
    }

    #[test]
    fn registers_and_dispatches_exact_canonical_operations() {
        tauri::async_runtime::block_on(async {
            let dispatcher =
                GatewayDispatcher::new([Arc::new(EchoOperation { id: "test.echo" }) as _])
                    .expect("registry should build");
            assert_eq!(dispatcher.operation_ids(), vec!["test.echo"]);
            assert_eq!(
                dispatcher
                    .handle("test.echo", json!({ "value": "ok" }))
                    .await
                    .expect("operation should succeed"),
                json!({ "value": "ok" })
            );

            let error = dispatcher
                .handle("test.Echo", json!({}))
                .await
                .expect_err("operation matching must be exact");
            assert_eq!(error.code, "GATEWAY_OPERATION_NOT_FOUND");
        });
    }

    #[test]
    fn rejects_invalid_duplicate_registration_and_invalid_dto() {
        tauri::async_runtime::block_on(async {
            let invalid = GatewayDispatcher::new([
                Arc::new(EchoOperation { id: "mysql" }) as Arc<dyn GatewayOperation>
            ]);
            assert_eq!(
                invalid.err(),
                Some(GatewayRegistryError::InvalidOperationId(
                    "mysql".to_string()
                ))
            );

            let duplicate = GatewayDispatcher::new([
                Arc::new(EchoOperation { id: "test.echo" }) as Arc<dyn GatewayOperation>,
                Arc::new(EchoOperation { id: "test.echo" }) as Arc<dyn GatewayOperation>,
            ]);
            assert_eq!(
                duplicate.err(),
                Some(GatewayRegistryError::DuplicateOperation(
                    "test.echo".to_string()
                ))
            );

            let dispatcher =
                GatewayDispatcher::new([Arc::new(EchoOperation { id: "test.echo" }) as _])
                    .expect("registry should build");
            let error = dispatcher
                .handle("test.echo", json!({ "value": "ok", "extra": true }))
                .await
                .expect_err("extra DTO fields must fail");
            assert_eq!(error.code, "GATEWAY_INVALID_REQUEST");
        });
    }

    #[test]
    fn normalizes_panics_without_exposing_internal_details() {
        tauri::async_runtime::block_on(async {
            let dispatcher = GatewayDispatcher::new([Arc::new(PanicOperation) as _])
                .expect("registry should build");
            let error = dispatcher
                .handle("test.panic", json!({}))
                .await
                .expect_err("panic must become a Gateway error");

            assert_eq!(error.code, "SYSTEM_INTERNAL");
            assert_eq!(error.message, "Backend Gateway operation failed.");
            assert!(!error.message.contains("secret"));
        });
    }
}
