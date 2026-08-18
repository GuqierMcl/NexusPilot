#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::engine::native_schema::{NativeSchemaExecutionStatus, NativeSchemaStatementProgress};
use crate::engine::types::{ContainerRef, SchemaMutationOperation};

use super::create_types::ClickHouseCreateTableTarget;
use super::types::ClickHouseTableSchema;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseColumnRenameIntent {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseAlterTableTarget {
    pub baseline: ClickHouseTableSchema,
    pub desired: ClickHouseCreateTableTarget,
    pub column_renames: Vec<ClickHouseColumnRenameIntent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDropTableTarget {
    pub container: ContainerRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDropDatabaseTarget {
    pub container: ContainerRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseColumnDataActionTarget {
    pub baseline: ClickHouseTableSchema,
    pub column_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProjectionTarget {
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProjectionCreateTarget {
    pub baseline: ClickHouseTableSchema,
    pub projection: ClickHouseProjectionTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProjectionActionTarget {
    pub baseline: ClickHouseTableSchema,
    pub projection_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSkippingIndexTarget {
    pub name: String,
    pub expression: String,
    pub index_type: String,
    pub type_arguments: Vec<String>,
    pub granularity: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSkippingIndexCreateTarget {
    pub baseline: ClickHouseTableSchema,
    pub index: ClickHouseSkippingIndexTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSkippingIndexActionTarget {
    pub baseline: ClickHouseTableSchema,
    pub index_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDatabaseObjectBaseline {
    pub name: String,
    pub engine: String,
    pub uuid: Option<String>,
    pub canonical_create_query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDatabaseBaseline {
    pub name: String,
    pub engine: String,
    pub uuid: Option<String>,
    pub objects: Vec<ClickHouseDatabaseObjectBaseline>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseTableAlterResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub table_name: String,
    pub schema: Option<ClickHouseTableSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseColumnActionResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub column_name: String,
    pub operation: SchemaMutationOperation,
    pub schema: Option<ClickHouseTableSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseProjectionChangeResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub projection_name: String,
    pub operation: SchemaMutationOperation,
    pub schema: Option<ClickHouseTableSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseSkippingIndexChangeResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub index_name: String,
    pub operation: SchemaMutationOperation,
    pub schema: Option<ClickHouseTableSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDropTableResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub table_name: String,
    pub absent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseDropDatabaseResult {
    pub status: NativeSchemaExecutionStatus,
    pub progress: NativeSchemaStatementProgress,
    pub container: ContainerRef,
    pub name: String,
    pub absent: bool,
}
