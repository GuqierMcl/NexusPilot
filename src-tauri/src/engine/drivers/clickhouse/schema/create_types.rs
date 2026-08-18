#![allow(dead_code)]

use serde::{Deserialize, Serialize};

use crate::engine::native_schema::NativeSchemaConfirmationInput;
use crate::engine::types::ContainerRef;

use super::types::{ClickHouseColumnDefaultKind, ClickHouseKeySchema, ClickHouseTableSchema};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCodecTarget {
    pub name: String,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateColumnTarget {
    pub name: String,
    pub type_name: String,
    pub default_kind: ClickHouseColumnDefaultKind,
    pub default_expression: Option<String>,
    pub codecs: Vec<ClickHouseCodecTarget>,
    pub ttl_expression: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateEngineTarget {
    pub family: String,
    pub arguments: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateSettingTarget {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateDatabaseTarget {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateTableTarget {
    pub database: String,
    pub name: String,
    pub columns: Vec<ClickHouseCreateColumnTarget>,
    pub engine: ClickHouseCreateEngineTarget,
    pub keys: ClickHouseKeySchema,
    pub table_ttl: Option<String>,
    pub comment: Option<String>,
    pub settings: Vec<ClickHouseCreateSettingTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseExecuteCreateDatabaseRequest {
    pub target: ClickHouseCreateDatabaseTarget,
    pub expected_plan_hash: String,
    pub confirmation: Option<NativeSchemaConfirmationInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseExecuteCreateTableRequest {
    pub target: ClickHouseCreateTableTarget,
    pub expected_plan_hash: String,
    pub confirmation: Option<NativeSchemaConfirmationInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateDatabaseResult {
    pub name: String,
    pub container: ContainerRef,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickHouseCreateTableResult {
    pub container: ContainerRef,
    pub table_name: String,
    pub schema: ClickHouseTableSchema,
}
