use crate::engine::driver::DatabaseDriver;
use crate::engine::types::ContainerRef;
use crate::error::IpcError;

pub const MAX_LOG_SNIPPET_CHARS: usize = 2048;

pub fn truncate_for_log(value: &str) -> String {
    if value.chars().count() <= MAX_LOG_SNIPPET_CHARS {
        return value.to_string();
    }

    let truncated = value
        .chars()
        .take(MAX_LOG_SNIPPET_CHARS)
        .collect::<String>();
    format!("{truncated}...[truncated]")
}

pub fn container_for_log(container: Option<&ContainerRef>) -> String {
    let Some(container) = container else {
        return "none".to_string();
    };

    let mut parts = vec![format!("kind={:?}", container.kind)];
    if let Some(group_type) = &container.group_type {
        parts.push(format!("group_type={group_type:?}"));
    }
    if let Some(database) = &container.database {
        parts.push(format!("database={}", truncate_for_log(database)));
    }
    if let Some(schema) = &container.schema {
        parts.push(format!("schema={}", truncate_for_log(schema)));
    }
    if let Some(table) = &container.table {
        parts.push(format!("table={}", truncate_for_log(table)));
    }
    if let Some(column) = &container.column {
        parts.push(format!("column={}", truncate_for_log(column)));
    }
    if let Some(object_name) = &container.object_name {
        parts.push(format!("object_name={}", truncate_for_log(object_name)));
    }
    if let Some(db_index) = container.db_index {
        parts.push(format!("db_index={db_index}"));
    }
    if let Some(key) = &container.key {
        parts.push(format!("key={}", truncate_for_log(key)));
    }
    if let Some(pattern) = &container.pattern {
        parts.push(format!("pattern={}", truncate_for_log(pattern)));
    }

    parts.join(" ")
}

pub fn format_engine_error_for_log(
    operation: &str,
    driver: &str,
    profile_id: &str,
    tab_id: Option<&str>,
    container: Option<&ContainerRef>,
    error: &IpcError,
) -> String {
    format!(
        "operation={} driver={} profile_id={} tab_id={} container=\"{}\" code={:?} message={} details={}",
        operation,
        driver,
        profile_id,
        tab_id.unwrap_or("none"),
        container_for_log(container),
        error.code,
        truncate_for_log(&error.message),
        error
            .details
            .as_deref()
            .map(truncate_for_log)
            .unwrap_or_else(|| "none".to_string())
    )
}

pub fn log_engine_error(
    operation: &str,
    profile_id: &str,
    tab_id: Option<&str>,
    driver: &dyn DatabaseDriver,
    container: Option<&ContainerRef>,
    error: &IpcError,
) {
    log_engine_error_by_driver(
        operation,
        driver.driver_name(),
        profile_id,
        tab_id,
        container,
        error,
    );
}

pub fn log_engine_error_by_driver(
    operation: &str,
    driver: &str,
    profile_id: &str,
    tab_id: Option<&str>,
    container: Option<&ContainerRef>,
    error: &IpcError,
) {
    tauri_plugin_log::log::error!(
        target: "nexpilot::engine",
        "{}",
        format_engine_error_for_log(
            operation,
            driver,
            profile_id,
            tab_id,
            container,
            error,
        )
    );
}

#[cfg(test)]
mod tests {
    use crate::engine::types::{ContainerKind, ContainerRef};
    use crate::error::IpcError;

    use super::{
        container_for_log, format_engine_error_for_log, truncate_for_log, MAX_LOG_SNIPPET_CHARS,
    };

    #[test]
    fn truncate_for_log_keeps_short_text_unchanged() {
        assert_eq!(truncate_for_log("SELECT 1"), "SELECT 1");
    }

    #[test]
    fn truncate_for_log_bounds_long_text() {
        let long = "x".repeat(MAX_LOG_SNIPPET_CHARS + 20);
        let truncated = truncate_for_log(&long);

        assert!(truncated.len() < long.len());
        assert!(truncated.ends_with("...[truncated]"));
    }

    #[test]
    fn container_for_log_summarizes_address_without_payloads() {
        let container = ContainerRef {
            kind: ContainerKind::Table,
            group_type: None,
            database: Some("FREEPDB1".to_string()),
            schema: Some("APP".to_string()),
            table: Some("USERS".to_string()),
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        };

        assert_eq!(
            container_for_log(Some(&container)),
            "kind=Table database=FREEPDB1 schema=APP table=USERS"
        );
        assert_eq!(container_for_log(None), "none");
    }

    #[test]
    fn format_engine_error_for_log_includes_runtime_context() {
        let error = IpcError::network_timeout(
            "Oracle connection was interrupted while executing SQL",
            "ORA-03113: end-of-file on communication channel",
        );
        let container = ContainerRef {
            kind: ContainerKind::Table,
            group_type: None,
            database: Some("FREEPDB1".to_string()),
            schema: Some("APP".to_string()),
            table: Some("USERS".to_string()),
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        };

        let formatted = format_engine_error_for_log(
            "commit_table_change_set",
            "oracle",
            "profile-1",
            Some("tab-1"),
            Some(&container),
            &error,
        );

        assert!(formatted.contains("operation=commit_table_change_set"));
        assert!(formatted.contains("driver=oracle"));
        assert!(formatted.contains("profile_id=profile-1"));
        assert!(formatted.contains("tab_id=tab-1"));
        assert!(formatted.contains("kind=Table database=FREEPDB1 schema=APP table=USERS"));
        assert!(formatted.contains("code=NetworkTimeout"));
        assert!(formatted.contains("message=Oracle connection was interrupted while executing SQL"));
        assert!(formatted.contains("details=ORA-03113"));
    }
}
