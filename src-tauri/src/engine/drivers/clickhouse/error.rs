use std::time::Duration;

use clickhouse::error::Error as ClickHouseError;

use crate::error::{ErrorCode, IpcError, RuntimeErrorImpact};

pub(super) fn classify_clickhouse_error(error: ClickHouseError, operation: &str) -> IpcError {
    let details = error.to_string();
    match error {
        ClickHouseError::Network(_) | ClickHouseError::TimedOut => {
            IpcError::network_timeout(format!("ClickHouse {operation} failed"), details)
        }
        ClickHouseError::BadResponse(_) if is_authentication_failure(&details) => {
            IpcError::auth_failed("ClickHouse authentication failed", details)
        }
        ClickHouseError::InvalidParams(_) => {
            IpcError::validation_failed(format!("ClickHouse {operation} has invalid parameters"))
        }
        _ => IpcError::system_internal(format!("ClickHouse {operation} failed"), details),
    }
}

pub(super) fn classify_metadata_error(error: ClickHouseError, operation: &str) -> IpcError {
    if is_permission_denied(&error) {
        return IpcError::permission_denied("ClickHouse metadata access denied");
    }
    if let ClickHouseError::BadResponse(details) = &error {
        if matches!(server_error_code(details), Some(47 | 60 | 81)) {
            return IpcError::feature_unavailable(format!(
                "ClickHouse metadata required for {operation} is unavailable"
            ));
        }
    }
    classify_clickhouse_error(error, operation)
}

#[allow(dead_code)]
pub(super) fn classify_query_error(error: ClickHouseError, operation: &str) -> IpcError {
    match error {
        ClickHouseError::Network(_) | ClickHouseError::TimedOut => IpcError::network_timeout(
            format!("ClickHouse {operation} failed"),
            format!("operation={operation}; category=transport"),
        ),
        ClickHouseError::BadResponse(details) if is_authentication_failure(&details) => {
            IpcError::auth_failed(
                "ClickHouse authentication failed",
                format!("operation={operation}; category=authentication"),
            )
        }
        ClickHouseError::BadResponse(details) => {
            let code = server_error_code(&details);
            if code == Some(1) {
                return local_query_error(
                    ErrorCode::FeatureUnavailable,
                    "ClickHouse server does not implement the requested operation",
                    operation,
                    "unsupported_method",
                    code,
                );
            }
            if is_readonly_failure(code, &details) {
                return local_query_error(
                    ErrorCode::ValidationFailed,
                    "ClickHouse rejected the statement in read-only mode",
                    operation,
                    "readonly",
                    code,
                );
            }
            if is_query_syntax_failure(code, &details) {
                return local_query_error(
                    ErrorCode::QuerySyntaxError,
                    "ClickHouse SQL syntax is invalid",
                    operation,
                    "syntax",
                    code,
                );
            }
            if is_permission_denied_details(&details) {
                return local_query_error(
                    ErrorCode::ValidationFailed,
                    "ClickHouse denied this query",
                    operation,
                    "permission",
                    code,
                );
            }
            local_query_error(
                ErrorCode::SystemInternal,
                format!("ClickHouse {operation} failed"),
                operation,
                "bad_response",
                code,
            )
        }
        ClickHouseError::InvalidParams(_) => local_query_error(
            ErrorCode::ValidationFailed,
            format!("ClickHouse {operation} has invalid parameters"),
            operation,
            "invalid_params",
            None,
        ),
        other => local_query_error(
            ErrorCode::SystemInternal,
            format!("ClickHouse {operation} failed"),
            operation,
            query_error_category(&other),
            None,
        ),
    }
}

pub(super) fn classify_schema_create_error(error: ClickHouseError, operation: &str) -> IpcError {
    match error {
        ClickHouseError::BadResponse(details)
            if matches!(server_error_code(&details), Some(57 | 82)) =>
        {
            IpcError::resource_conflict(format!("ClickHouse {operation} target already exists"))
        }
        other => classify_query_error(other, operation),
    }
}

pub(super) fn classify_schema_change_error(error: ClickHouseError, operation: &str) -> IpcError {
    match error {
        ClickHouseError::BadResponse(details) => match server_error_code(&details) {
            Some(60 | 81 | 582) => IpcError::resource_not_found(format!(
                "ClickHouse {operation} target no longer exists"
            )),
            Some(36) if is_skipping_index_missing_operation(operation) => {
                IpcError::resource_not_found(format!(
                    "ClickHouse {operation} target no longer exists"
                ))
            }
            Some(16 | 44 | 583) => IpcError::resource_conflict(format!(
                "ClickHouse {operation} target changed before execution"
            )),
            _ => classify_query_error(ClickHouseError::BadResponse(details), operation),
        },
        other => classify_query_error(other, operation),
    }
}

fn is_skipping_index_missing_operation(operation: &str) -> bool {
    matches!(
        operation,
        "skipping-index drop" | "skipping-index materialize" | "skipping-index clear"
    )
}

pub(super) fn probe_timeout(operation: &str, timeout: Duration) -> IpcError {
    IpcError::network_timeout(
        format!("ClickHouse {operation} timed out"),
        format!("Probe exceeded {} ms", timeout.as_millis()),
    )
}

pub(super) fn managed_query_timeout(execution_id: &str, timeout_ms: u64) -> IpcError {
    IpcError::operation_timeout(
        "ClickHouse query exceeded its execution timeout",
        format!("execution_id={execution_id}; timeout_ms={timeout_ms}"),
    )
}

pub(super) fn progress_warning(error: &ClickHouseError) -> &'static str {
    if is_permission_denied(error) {
        return "ClickHouse system.processes 权限不足，实时进度不可用";
    }
    if let ClickHouseError::BadResponse(details) = error {
        let normalized = details.to_ascii_uppercase();
        if normalized.contains("CODE: 47")
            || normalized.contains("UNKNOWN_IDENTIFIER")
            || normalized.contains("UNKNOWN COLUMN")
        {
            return "ClickHouse system.processes 列不兼容，实时进度不可用";
        }
    }
    "ClickHouse 实时进度轮询失败，实时进度不可用"
}

pub(super) fn is_permission_denied(error: &ClickHouseError) -> bool {
    let ClickHouseError::BadResponse(details) = error else {
        return false;
    };
    is_permission_denied_details(details)
}

fn is_permission_denied_details(details: &str) -> bool {
    let normalized = details.to_ascii_uppercase();
    normalized.contains("CODE: 497")
        || normalized.contains("ACCESS_DENIED")
        || normalized.contains("NOT ENOUGH PRIVILEGES")
}

fn is_readonly_failure(code: Option<u32>, details: &str) -> bool {
    let normalized = details.to_ascii_uppercase();
    code == Some(164)
        || normalized.contains("READONLY")
        || normalized.contains("READ_ONLY")
        || normalized.contains("READ-ONLY")
        || normalized.contains("READ ONLY MODE")
}

fn is_query_syntax_failure(code: Option<u32>, details: &str) -> bool {
    let normalized = details.to_ascii_uppercase();
    matches!(code, Some(47 | 62))
        || normalized.contains("SYNTAX_ERROR")
        || normalized.contains("UNKNOWN_IDENTIFIER")
}

pub(in crate::engine::drivers::clickhouse) fn server_error_code(details: &str) -> Option<u32> {
    let normalized = details.to_ascii_uppercase();
    let marker = normalized.find("CODE:")? + "CODE:".len();
    normalized[marker..]
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn local_query_error(
    code: ErrorCode,
    message: impl Into<String>,
    operation: &str,
    category: &str,
    server_code: Option<u32>,
) -> IpcError {
    IpcError {
        code,
        runtime_impact: RuntimeErrorImpact::BusinessOnly,
        message: message.into(),
        details: Some(format!(
            "operation={operation}; category={category}; server_code={}",
            server_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )),
    }
}

fn query_error_category(error: &ClickHouseError) -> &'static str {
    match error {
        ClickHouseError::Compression(_) => "compression",
        ClickHouseError::Decompression(_) => "decompression",
        ClickHouseError::RowNotFound => "row_not_found",
        ClickHouseError::SequenceMustHaveLength => "sequence_length",
        ClickHouseError::DeserializeAnyNotSupported => "deserialize_any",
        ClickHouseError::NotEnoughData => "not_enough_data",
        ClickHouseError::InvalidUtf8Encoding(_) => "invalid_utf8",
        ClickHouseError::InvalidTagEncoding(_) => "invalid_tag",
        ClickHouseError::VariantDiscriminatorIsOutOfBound(_) => "variant_discriminator",
        ClickHouseError::Custom(_) => "custom",
        ClickHouseError::InvalidColumnsHeader(_) => "columns_header",
        ClickHouseError::SchemaMismatch(_) => "schema_mismatch",
        ClickHouseError::Unsupported(_) => "unsupported",
        ClickHouseError::Other(_) => "other",
        _ => "unknown",
    }
}

fn is_authentication_failure(details: &str) -> bool {
    let normalized = details.to_ascii_uppercase();
    normalized.contains("CODE: 516")
        || normalized.contains("AUTHENTICATION_FAILED")
        || normalized.contains("REQUIRED_PASSWORD")
        || normalized.contains("PASSWORD IS INCORRECT")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::{ErrorCode, RuntimeErrorImpact};

    #[test]
    fn unrelated_bad_response_is_not_treated_as_authentication_failure() {
        let error = classify_clickhouse_error(
            ClickHouseError::BadResponse("Code: 62. Syntax error".to_string()),
            "probe",
        );

        assert_eq!(error.code, ErrorCode::SystemInternal);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
    }

    #[test]
    fn permission_detection_does_not_hide_non_permission_failures() {
        assert!(!is_permission_denied(&ClickHouseError::TimedOut));
        assert!(!is_permission_denied(&ClickHouseError::BadResponse(
            "Code: 516. AUTHENTICATION_FAILED".to_string()
        )));
    }

    #[test]
    fn metadata_permission_denial_is_local_business_failure() {
        let error = classify_metadata_error(
            ClickHouseError::BadResponse(
                "Code: 497. DB::Exception: ACCESS_DENIED password=secret".to_string(),
            ),
            "list projections",
        );

        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert_eq!(error.message, "ClickHouse metadata access denied");
        assert!(error.details.is_none());
    }

    #[test]
    fn missing_view_metadata_is_feature_unavailable_and_redacted() {
        let error = classify_metadata_error(
            ClickHouseError::BadResponse(
                "Code: 60. UNKNOWN_TABLE system.view_refreshes password=secret".to_string(),
            ),
            "inspect refreshable View support",
        );

        assert_eq!(error.code, ErrorCode::FeatureUnavailable);
        assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
        assert!(error.details.is_none());
    }

    #[test]
    fn metadata_transport_and_auth_keep_phase_one_runtime_impact() {
        let timeout = classify_metadata_error(ClickHouseError::TimedOut, "list tables");
        let auth = classify_metadata_error(
            ClickHouseError::BadResponse("Code: 516. AUTHENTICATION_FAILED".to_string()),
            "list tables",
        );

        assert_eq!(timeout.runtime_impact, RuntimeErrorImpact::Retryable);
        assert_eq!(auth.runtime_impact, RuntimeErrorImpact::Terminal);
    }

    #[test]
    fn query_readonly_syntax_and_permission_errors_are_local_and_redacted() {
        let readonly = classify_query_error(
            ClickHouseError::BadResponse(
                "Code: 164. READONLY. query=INSERT secret-value".to_string(),
            ),
            "execute SQL",
        );
        let syntax = classify_query_error(
            ClickHouseError::BadResponse("Code: 62. SYNTAX_ERROR near password=secret".to_string()),
            "execute SQL",
        );
        let permission = classify_query_error(
            ClickHouseError::BadResponse("Code: 497. ACCESS_DENIED password=secret".to_string()),
            "execute SQL",
        );
        let unsupported = classify_query_error(
            ClickHouseError::BadResponse(
                "Code: 1. UNSUPPORTED_METHOD query=CREATE secret".to_string(),
            ),
            "execute SQL",
        );

        assert_eq!(readonly.code, ErrorCode::ValidationFailed);
        assert_eq!(syntax.code, ErrorCode::QuerySyntaxError);
        assert_eq!(permission.code, ErrorCode::ValidationFailed);
        assert_eq!(unsupported.code, ErrorCode::FeatureUnavailable);
        for error in [readonly, syntax, permission, unsupported] {
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            let details = error.details.as_deref().unwrap_or_default();
            assert!(!details.contains("secret"));
            assert!(!details.contains("INSERT"));
        }
    }

    #[test]
    fn query_transport_and_auth_preserve_runtime_impact_without_server_secrets() {
        let timeout = classify_query_error(ClickHouseError::TimedOut, "execute SQL");
        let auth = classify_query_error(
            ClickHouseError::BadResponse(
                "Code: 516. AUTHENTICATION_FAILED password=secret".to_string(),
            ),
            "execute SQL",
        );

        assert_eq!(timeout.code, ErrorCode::NetworkTimeout);
        assert_eq!(timeout.runtime_impact, RuntimeErrorImpact::Retryable);
        assert_eq!(auth.code, ErrorCode::AuthFailed);
        assert_eq!(auth.runtime_impact, RuntimeErrorImpact::Terminal);
        assert!(!auth
            .details
            .as_deref()
            .unwrap_or_default()
            .contains("secret"));
    }

    #[test]
    fn schema_create_conflicts_and_failures_are_structured_and_redacted() {
        for code in [57, 82] {
            let error = classify_schema_create_error(
                ClickHouseError::BadResponse(format!(
                    "Code: {code}. target=analytics.events query=CREATE password=secret"
                )),
                "create table",
            );
            assert_eq!(error.code, ErrorCode::ResourceConflict);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            assert!(error.details.is_none());
        }

        for (details, code) in [
            (
                "Code: 62. SYNTAX_ERROR query=CREATE secret",
                ErrorCode::QuerySyntaxError,
            ),
            (
                "Code: 497. ACCESS_DENIED password=secret",
                ErrorCode::ValidationFailed,
            ),
        ] {
            let error = classify_schema_create_error(
                ClickHouseError::BadResponse(details.to_string()),
                "create table",
            );
            assert_eq!(error.code, code);
            let diagnostic = error.details.as_deref().unwrap_or_default();
            assert!(!diagnostic.contains("secret"));
            assert!(!diagnostic.contains("CREATE"));
            assert!(!diagnostic.contains("analytics"));
        }
    }

    #[test]
    fn schema_change_missing_targets_are_resource_not_found_and_redacted() {
        for code in [60, 81] {
            let error = classify_schema_change_error(
                ClickHouseError::BadResponse(format!(
                    "Code: {code}. UNKNOWN_TABLE query=ALTER password=secret"
                )),
                "alter table",
            );
            assert_eq!(error.code, ErrorCode::ResourceNotFound);
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            assert!(!format!("{error:?}").contains("secret"));
            assert!(!format!("{error:?}").contains("ALTER"));
        }
    }

    #[test]
    fn schema_change_object_codes_use_only_redacted_operation_categories() {
        for (code, operation, expected) in [
            (582, "projection drop", ErrorCode::ResourceNotFound),
            (583, "projection create", ErrorCode::ResourceConflict),
            (36, "skipping-index drop", ErrorCode::ResourceNotFound),
            (44, "skipping-index create", ErrorCode::ResourceConflict),
        ] {
            let error = classify_schema_change_error(
                ClickHouseError::BadResponse(format!(
                    "Code: {code}. object=SECRET_OBJECT query=ALTER TABLE analytics.events password=secret"
                )),
                operation,
            );
            assert_eq!(error.code, expected, "{operation}");
            assert_eq!(error.runtime_impact, RuntimeErrorImpact::BusinessOnly);
            let diagnostic = format!("{error:?}");
            assert!(!diagnostic.contains("SECRET_OBJECT"));
            assert!(!diagnostic.contains("analytics.events"));
            assert!(!diagnostic.contains("secret"));
        }
    }
}
