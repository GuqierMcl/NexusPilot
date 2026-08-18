use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    Sqlx(sqlx::Error),
    SqlxMigrate(sqlx::migrate::MigrateError),
    SerdeJson(serde_json::Error),
    Tauri(tauri::Error),
    TauriStore(tauri_plugin_store::Error),
    Validation(String),
    NotFound(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Sqlx(error) => write!(f, "Database error: {error}"),
            Self::SqlxMigrate(error) => write!(f, "Database migration error: {error}"),
            Self::SerdeJson(error) => write!(f, "JSON error: {error}"),
            Self::Tauri(error) => write!(f, "Tauri error: {error}"),
            Self::TauriStore(error) => write!(f, "Tauri store error: {error}"),
            Self::Validation(message) => write!(f, "{message}"),
            Self::NotFound(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sqlx(value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::SerdeJson(value)
    }
}

impl From<sqlx::migrate::MigrateError> for AppError {
    fn from(value: sqlx::migrate::MigrateError) -> Self {
        Self::SqlxMigrate(value)
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self::Tauri(value)
    }
}

impl From<tauri_plugin_store::Error> for AppError {
    fn from(value: tauri_plugin_store::Error) -> Self {
        Self::TauriStore(value)
    }
}

// ─── IPC-facing Error Types ───────────────────────────────────────────────────
// Used exclusively by connection engine commands. Separate from the internal
// AppError which is only used within the local-storage (SQLite) module.

/// Structured error codes exposed to the frontend via Tauri IPC.
/// Must be kept in sync with `src/types/ipc.ts` ErrorCode.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Authentication failure: wrong credentials, token expired.
    AuthFailed,
    /// Network-level timeout or connection refused.
    NetworkTimeout,
    /// A bounded database operation exceeded its configured execution deadline.
    #[allow(dead_code)]
    OperationTimeout,
    /// A remote mutation may have completed, but its final state could not be verified.
    #[allow(dead_code)]
    OperationOutcomeUnknown,
    /// SQL / Cypher syntax error returned by the database.
    QuerySyntaxError,
    /// Requested entity (database, table, file) not found.
    ResourceNotFound,
    /// Request payload or operation intent is invalid for the target resource.
    ValidationFailed,
    /// Requested mutation conflicts with an existing resource.
    ResourceConflict,
    /// The connected server/version/edition explicitly does not provide a feature.
    FeatureUnavailable,
    /// The authenticated principal does not have the required permission.
    PermissionDenied,
    /// Internal system failure: pool crash, Tauri core error, etc.
    SystemInternal,
    /// User-initiated cancellation.
    // Reserved for future use; kept to maintain API contract with the frontend.
    #[allow(dead_code)]
    OperationCanceled,
}

/// Explicit effect of an IPC failure on the owning database runtime session.
#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeErrorImpact {
    BusinessOnly,
    Retryable,
    Terminal,
}

/// Serialisable error shell sent to the frontend over IPC.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub runtime_impact: RuntimeErrorImpact,
    /// Human-readable message suitable for display in the UI.
    pub message: String,
    /// Raw lower-level error string; populated only in DEV builds.
    pub details: Option<String>,
}

impl IpcError {
    pub fn auth_failed(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::AuthFailed,
            runtime_impact: RuntimeErrorImpact::Terminal,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    pub fn network_timeout(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::NetworkTimeout,
            runtime_impact: RuntimeErrorImpact::Retryable,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    #[allow(dead_code)]
    pub fn operation_timeout(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::OperationTimeout,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    #[allow(dead_code)]
    pub fn operation_outcome_unknown(
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: ErrorCode::OperationOutcomeUnknown,
            runtime_impact: RuntimeErrorImpact::Retryable,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    pub fn query_syntax(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::QuerySyntaxError,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    pub fn resource_not_found(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::ResourceNotFound,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: None,
        }
    }
    pub fn validation_failed(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::ValidationFailed,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: None,
        }
    }
    pub fn resource_conflict(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::ResourceConflict,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: None,
        }
    }
    pub fn feature_unavailable(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::FeatureUnavailable,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: None,
        }
    }
    #[allow(dead_code)]
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::PermissionDenied,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: None,
        }
    }
    pub fn system_internal(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::SystemInternal,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: Some(details.into()),
        }
    }
    pub fn operation_canceled(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self {
            code: ErrorCode::OperationCanceled,
            runtime_impact: RuntimeErrorImpact::BusinessOnly,
            message: message.into(),
            details: Some(details.into()),
        }
    }
}

/// Project-level Result alias for IPC-facing commands.
pub type IpcResult<T> = Result<T, IpcError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_runtime_impact_serializes_with_frontend_casing() {
        let retryable = IpcError::network_timeout("network", "connection refused");
        let retryable_json = serde_json::to_value(retryable).expect("serialize retryable error");
        assert_eq!(retryable_json["code"], "NETWORK_TIMEOUT");
        assert_eq!(retryable_json["runtimeImpact"], "retryable");

        let business = IpcError::operation_timeout("query timeout", "elapsed");
        let business_json = serde_json::to_value(business).expect("serialize business error");
        assert_eq!(business_json["code"], "OPERATION_TIMEOUT");
        assert_eq!(business_json["runtimeImpact"], "businessOnly");

        let outcome_unknown = IpcError::operation_outcome_unknown(
            "ClickHouse create result could not be verified",
            "operation=create_table; category=outcome_unknown",
        );
        assert_eq!(outcome_unknown.code, ErrorCode::OperationOutcomeUnknown);
        assert_eq!(
            outcome_unknown.runtime_impact,
            RuntimeErrorImpact::Retryable
        );
        let outcome_json =
            serde_json::to_value(outcome_unknown).expect("serialize outcome unknown error");
        assert_eq!(outcome_json["code"], "OPERATION_OUTCOME_UNKNOWN");
        assert_eq!(outcome_json["runtimeImpact"], "retryable");
    }

    #[test]
    fn feature_and_permission_errors_are_business_only() {
        let cases = [
            (
                IpcError::feature_unavailable("ClickHouse feature is unavailable"),
                ErrorCode::FeatureUnavailable,
                "FEATURE_UNAVAILABLE",
            ),
            (
                IpcError::permission_denied("ClickHouse permission is required"),
                ErrorCode::PermissionDenied,
                "PERMISSION_DENIED",
            ),
        ];

        for (error, code, serialized_code) in cases {
            assert_eq!(error.code, code);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            let value = serde_json::to_value(error).expect("serialize IPC error");
            assert_eq!(value["code"], serialized_code);
            assert_eq!(value["runtimeImpact"], "businessOnly");
        }
    }
}
