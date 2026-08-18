use std::collections::BTreeSet;

use async_trait::async_trait;

use crate::error::{IpcError, IpcResult};

#[async_trait]
pub(super) trait SystemCatalogColumnProbe: Send + Sync {
    async fn available_system_columns(
        &self,
        system_table: &'static str,
    ) -> IpcResult<BTreeSet<String>>;
}

pub(super) fn require_catalog_columns(
    available: &BTreeSet<String>,
    system_table: &str,
    required: &[&str],
) -> IpcResult<()> {
    let missing = required
        .iter()
        .filter(|column| !available.contains(**column))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(IpcError::system_internal(
        "ClickHouse metadata is incompatible with this server",
        format!(
            "Required system.{system_table} columns are unavailable: {}",
            missing.join(", ")
        ),
    ))
}

pub(super) fn optional_text_column(
    available: &BTreeSet<String>,
    source: &str,
    alias: &str,
) -> String {
    if available.contains(source) {
        if source == alias {
            source.to_string()
        } else {
            format!("{source} AS {alias}")
        }
    } else {
        format!("'' AS {alias}")
    }
}

pub(super) fn optional_nullable_column(
    available: &BTreeSet<String>,
    source: &str,
    type_name: &str,
    alias: &str,
) -> String {
    if available.contains(source) {
        format!("CAST({source}, 'Nullable({type_name})') AS {alias}")
    } else {
        format!("CAST(NULL, 'Nullable({type_name})') AS {alias}")
    }
}

pub(super) fn optional_system_table_is_absent(
    system_table: &str,
    available: &BTreeSet<String>,
) -> bool {
    available.is_empty()
        && matches!(
            system_table,
            "dictionaries" | "data_skipping_indices" | "projections"
        )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn optional_catalog_expression_uses_typed_fallback() {
        let available = BTreeSet::from([
            "database".to_string(),
            "table".to_string(),
            "name".to_string(),
        ]);

        assert_eq!(
            optional_text_column(&available, "query", "definition"),
            "'' AS definition"
        );
        assert_eq!(
            optional_nullable_column(&available, "granularity", "UInt64", "granularity"),
            "CAST(NULL, 'Nullable(UInt64)') AS granularity"
        );
    }

    #[test]
    fn catalog_required_columns_fail_without_leaking_query_text() {
        let available = BTreeSet::from(["name".to_string()]);
        let error = require_catalog_columns(&available, "tables", &["database", "name", "engine"])
            .expect_err("missing identity columns must fail");

        assert_eq!(error.code, crate::error::ErrorCode::SystemInternal);
        assert!(error
            .details
            .as_deref()
            .is_some_and(|details| details.contains("database, engine")));
        assert!(!error
            .details
            .as_deref()
            .is_some_and(|details| details.contains("SELECT")));
    }

    #[test]
    fn optional_system_tables_are_absent_only_for_approved_catalogs() {
        assert!(optional_system_table_is_absent(
            "projections",
            &BTreeSet::new()
        ));
        assert!(!optional_system_table_is_absent("tables", &BTreeSet::new()));
    }
}
