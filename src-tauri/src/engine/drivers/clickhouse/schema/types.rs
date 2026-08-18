use serde::{Deserialize, Serialize};

use crate::engine::types::ContainerKind;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClickHouseColumnDefaultKind {
    None,
    Default,
    Materialized,
    Alias,
    Ephemeral,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClickHouseSchemaEditabilityMode {
    Editable,
    Restricted,
    Readonly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSchemaBlocker {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSchemaEditability {
    pub mode: ClickHouseSchemaEditabilityMode,
    pub blockers: Vec<ClickHouseSchemaBlocker>,
}

impl ClickHouseSchemaEditability {
    pub fn editable() -> Self {
        Self {
            mode: ClickHouseSchemaEditabilityMode::Editable,
            blockers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseTableIdentity {
    pub database: String,
    pub name: String,
    pub object_kind: ContainerKind,
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseEngineSchema {
    pub family: String,
    pub arguments: Vec<String>,
    pub raw_expression: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseColumnSchema {
    pub name: String,
    pub type_name: String,
    pub position: u64,
    pub default_kind: ClickHouseColumnDefaultKind,
    pub default_expression: Option<String>,
    pub codec_expression: Option<String>,
    pub ttl_expression: Option<String>,
    pub comment: Option<String>,
    pub editability: ClickHouseSchemaEditability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseKeySchema {
    pub order_by: String,
    pub partition_by: Option<String>,
    pub primary_key: Option<String>,
    pub sample_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSettingSchema {
    pub name: String,
    pub value: String,
    pub explicit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProjectionSchema {
    pub name: String,
    pub query: String,
    pub editability: ClickHouseSchemaEditability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSkippingIndexSchema {
    pub name: String,
    pub expression: String,
    pub index_type: String,
    pub type_arguments: Vec<String>,
    pub granularity: Option<u64>,
    pub editability: ClickHouseSchemaEditability,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSchemaBaseline {
    pub canonical_create_query: String,
    pub revision_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseTableSchema {
    pub identity: ClickHouseTableIdentity,
    pub engine: ClickHouseEngineSchema,
    pub columns: Vec<ClickHouseColumnSchema>,
    pub keys: ClickHouseKeySchema,
    pub table_ttl: Option<String>,
    pub comment: Option<String>,
    pub settings: Vec<ClickHouseSettingSchema>,
    pub projections: Vec<ClickHouseProjectionSchema>,
    pub skipping_indexes: Vec<ClickHouseSkippingIndexSchema>,
    pub editability: ClickHouseSchemaEditability,
    pub baseline: ClickHouseSchemaBaseline,
}

#[cfg(test)]
pub(super) fn fixture_schema() -> ClickHouseTableSchema {
    ClickHouseTableSchema {
        identity: ClickHouseTableIdentity {
            database: "analytics".to_string(),
            name: "events".to_string(),
            object_kind: crate::engine::types::ContainerKind::Table,
            uuid: Some("00000000-0000-0000-0000-000000000001".to_string()),
        },
        engine: ClickHouseEngineSchema {
            family: "ReplacingMergeTree".to_string(),
            arguments: vec!["version".to_string()],
            raw_expression: "ReplacingMergeTree(version)".to_string(),
        },
        columns: vec![
            ClickHouseColumnSchema {
                name: "id".to_string(),
                type_name: "UInt64".to_string(),
                position: 1,
                default_kind: ClickHouseColumnDefaultKind::None,
                default_expression: None,
                codec_expression: Some("CODEC(Delta, ZSTD(1))".to_string()),
                ttl_expression: None,
                comment: Some("event id".to_string()),
                editability: ClickHouseSchemaEditability::editable(),
            },
            ClickHouseColumnSchema {
                name: "day".to_string(),
                type_name: "Date".to_string(),
                position: 2,
                default_kind: ClickHouseColumnDefaultKind::Materialized,
                default_expression: Some("toDate(created_at)".to_string()),
                codec_expression: None,
                ttl_expression: None,
                comment: None,
                editability: ClickHouseSchemaEditability::editable(),
            },
        ],
        keys: ClickHouseKeySchema {
            order_by: "(tenant_id, id)".to_string(),
            partition_by: Some("toYYYYMM(created_at)".to_string()),
            primary_key: Some("(tenant_id, id)".to_string()),
            sample_by: Some("id".to_string()),
        },
        table_ttl: Some("created_at + INTERVAL 90 DAY DELETE".to_string()),
        comment: Some("events".to_string()),
        settings: vec![
            ClickHouseSettingSchema {
                name: "index_granularity".to_string(),
                value: "8192".to_string(),
                explicit: true,
            },
            ClickHouseSettingSchema {
                name: "allow_nullable_key".to_string(),
                value: "1".to_string(),
                explicit: true,
            },
        ],
        projections: vec![
            ClickHouseProjectionSchema {
                name: "z_projection".to_string(),
                query: "SELECT id ORDER BY id".to_string(),
                editability: ClickHouseSchemaEditability::editable(),
            },
            ClickHouseProjectionSchema {
                name: "a_projection".to_string(),
                query: "SELECT day, count() GROUP BY day".to_string(),
                editability: ClickHouseSchemaEditability::editable(),
            },
        ],
        skipping_indexes: vec![
            ClickHouseSkippingIndexSchema {
                name: "z_index".to_string(),
                expression: "id".to_string(),
                index_type: "minmax".to_string(),
                type_arguments: Vec::new(),
                granularity: Some(1),
                editability: ClickHouseSchemaEditability::editable(),
            },
            ClickHouseSkippingIndexSchema {
                name: "a_index".to_string(),
                expression: "day".to_string(),
                index_type: "set".to_string(),
                type_arguments: vec!["100".to_string()],
                granularity: Some(4),
                editability: ClickHouseSchemaEditability::editable(),
            },
        ],
        editability: ClickHouseSchemaEditability::editable(),
        baseline: ClickHouseSchemaBaseline {
            canonical_create_query: "CREATE TABLE analytics.events ENGINE = ReplacingMergeTree(version) ORDER BY (tenant_id, id)".to_string(),
            revision_hash: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clickhouse_schema_uses_native_default_and_editability_values() {
        let value = serde_json::to_value(fixture_schema()).expect("serialize schema");

        assert_eq!(value["identity"]["objectKind"], "table");
        assert_eq!(
            value["engine"]["rawExpression"],
            "ReplacingMergeTree(version)"
        );
        assert_eq!(value["columns"][0]["defaultKind"], "none");
        assert_eq!(value["columns"][1]["defaultKind"], "materialized");
        assert_eq!(value["editability"]["mode"], "editable");
        assert_eq!(value["skippingIndexes"][1]["typeArguments"][0], "100");
        assert_eq!(value["baseline"]["revisionHash"], "");
    }
}
