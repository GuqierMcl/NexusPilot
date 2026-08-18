use clickhouse::Client;
use serde::Deserialize;

use crate::engine::manager::ConnectionRuntimeManager;
use crate::engine::types::{
    ContainerKind, ContainerRef, QueryResult, TableBrowseQuery, TableCellChange,
    TableChangeOutcome, TableChangeSetInsert, TableChangeSetRequest, TableChangeSetUpdate,
    TableRowKeyPart, TableRowLocator, TableRowLocatorStrategy,
};
use crate::error::{ErrorCode, IpcError, IpcResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DataTableCrudEvidence {
    pub(super) inserts: u64,
    pub(super) updates: u64,
    pub(super) deletes: u64,
    pub(super) conflicts: u64,
    pub(super) generated_rejections: u64,
}

impl DataTableCrudEvidence {
    pub(super) fn marker(self) -> String {
        format!(
            "ClickHouse basic DataTable CRUD checkpoint passed: inserts={}; updates={}; deletes={}; conflicts={}; generated_rejections={}",
            self.inserts,
            self.updates,
            self.deletes,
            self.conflicts,
            self.generated_rejections,
        )
    }
}

#[derive(Debug, clickhouse::Row, Deserialize)]
struct FactsRow {
    id: u64,
    name: String,
    score: Option<i32>,
    label: String,
    normalized: String,
}

pub(super) async fn run(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    client: &Client,
    database: &str,
    prefix: &str,
) -> IpcResult<DataTableCrudEvidence> {
    let table_name = format!("{prefix}datatable_crud");
    let qualified = format!(
        "{}.{}",
        quote_identifier(database),
        quote_identifier(&table_name)
    );
    execute_fixture(client, &format!("DROP TABLE IF EXISTS {qualified} SYNC")).await?;
    execute_fixture(
        client,
        &format!(
            "CREATE TABLE {qualified} (\
             id UInt64, \
             name String, \
             score Nullable(Int32), \
             label LowCardinality(String), \
             created_at DateTime64(3, 'UTC') DEFAULT now64(3), \
             normalized String MATERIALIZED lower(name), \
             alias_id UInt64 ALIAS id\
             ) ENGINE = MergeTree ORDER BY id"
        ),
    )
    .await?;
    execute_fixture(
        client,
        &format!(
            "INSERT INTO {qualified} (id, name, score, label) VALUES \
             (1, 'before', 10, 'alpha'), (2, 'delete-me', NULL, 'beta')"
        ),
    )
    .await?;

    let result = run_matrix(
        manager,
        profile_id,
        tab_id,
        client,
        database,
        &table_name,
        &qualified,
    )
    .await;
    let cleanup = execute_fixture(client, &format!("DROP TABLE IF EXISTS {qualified} SYNC")).await;
    match (result, cleanup) {
        (Ok(evidence), Ok(())) => Ok(evidence),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(_)) => Err(IpcError::system_internal(
            "ClickHouse DataTable CRUD 验证失败，且测试表清理不完整",
            format!("primary_code={:?}", primary.code),
        )),
    }
}

async fn run_matrix(
    manager: &ConnectionRuntimeManager,
    profile_id: &str,
    tab_id: &str,
    client: &Client,
    database: &str,
    table_name: &str,
    qualified: &str,
) -> IpcResult<DataTableCrudEvidence> {
    let container = ContainerRef::table(
        ContainerKind::Table,
        database.to_string(),
        None,
        table_name.to_string(),
    );
    let browsed = manager
        .browse_table_data(
            profile_id,
            Some(tab_id),
            &container,
            1,
            100,
            &TableBrowseQuery::default(),
        )
        .await?;
    if !browsed.source_insertable
        || !browsed.source_writable
        || browsed.row_locator_strategy != Some(TableRowLocatorStrategy::RowSnapshot)
    {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable 未发布安全的行快照写入能力",
            "expected insert/update/delete resource capabilities",
        ));
    }
    if browsed.primary_key_columns.len() != 0 {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable 错误地暴露了唯一主键",
            "primary_key_columns must stay empty for ClickHouse",
        ));
    }
    let row_one = row_locator(&browsed, 1)?;
    let row_two = row_locator(&browsed, 2)?;
    let change_set = TableChangeSetRequest {
        inserts: vec![TableChangeSetInsert {
            values: vec![
                cell("id", 3_u64),
                cell("name", "inserted"),
                TableCellChange {
                    column: "score".to_string(),
                    value: serde_json::Value::Null,
                },
                cell("label", "gamma"),
            ],
        }],
        updates: vec![TableChangeSetUpdate {
            locator: row_one.clone(),
            changes: vec![cell("name", "after")],
        }],
        deletes: vec![row_two],
    };

    let preview = manager
        .preview_table_change_set(profile_id, Some(tab_id), &container, &change_set)
        .await?;
    if preview.summary.inserts != 1
        || preview.summary.updates != 1
        || preview.summary.deletes != 1
        || preview.statements.len() != 3
    {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable CRUD 预览摘要不完整",
            "expected one insert, update, and delete statement",
        ));
    }
    let committed = manager
        .commit_table_change_set(profile_id, Some(tab_id), &container, &change_set)
        .await?;
    if committed.outcome != TableChangeOutcome::Applied || committed.affected_rows != 3 {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable CRUD 未返回已核验的完成结果",
            format!(
                "outcome={:?}; affected_rows={}",
                committed.outcome, committed.affected_rows
            ),
        ));
    }

    let facts = client
        .query(&format!(
            "SELECT id, name, score, label, normalized FROM {qualified} ORDER BY id"
        ))
        .fetch_all::<FactsRow>()
        .await
        .map_err(|error| fixture_error("read CRUD facts", error))?;
    if facts.len() != 2
        || facts[0].id != 1
        || facts[0].name != "after"
        || facts[0].score != Some(10)
        || facts[0].label != "alpha"
        || facts[0].normalized != "after"
        || facts[1].id != 3
        || facts[1].name != "inserted"
        || facts[1].score.is_some()
        || facts[1].label != "gamma"
        || facts[1].normalized != "inserted"
    {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable CRUD 执行后的数据事实不符合预期",
            "post-write fact matrix mismatch",
        ));
    }

    let conflict = manager
        .preview_table_change_set(
            profile_id,
            Some(tab_id),
            &container,
            &TableChangeSetRequest {
                inserts: Vec::new(),
                updates: vec![TableChangeSetUpdate {
                    locator: row_one,
                    changes: vec![cell("name", "stale")],
                }],
                deletes: Vec::new(),
            },
        )
        .await
        .expect_err("stale row snapshot must conflict");
    if conflict.code != ErrorCode::ResourceConflict {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable 未把过期行快照识别为冲突",
            format!("actual_code={:?}", conflict.code),
        ));
    }

    let fresh = manager
        .browse_table_data(
            profile_id,
            Some(tab_id),
            &container,
            1,
            100,
            &TableBrowseQuery::default(),
        )
        .await?;
    let fresh_row = row_locator(&fresh, 1)?;
    let generated = manager
        .preview_table_change_set(
            profile_id,
            Some(tab_id),
            &container,
            &TableChangeSetRequest {
                inserts: Vec::new(),
                updates: vec![TableChangeSetUpdate {
                    locator: fresh_row,
                    changes: vec![cell("normalized", "manual")],
                }],
                deletes: Vec::new(),
            },
        )
        .await
        .expect_err("materialized column write must be rejected");
    if generated.code != ErrorCode::FeatureUnavailable {
        return Err(IpcError::system_internal(
            "ClickHouse DataTable 未拒绝数据库生成列写入",
            format!("actual_code={:?}", generated.code),
        ));
    }

    Ok(DataTableCrudEvidence {
        inserts: 1,
        updates: 1,
        deletes: 1,
        conflicts: 1,
        generated_rejections: 1,
    })
}

fn row_locator(result: &QueryResult, id: u64) -> IpcResult<TableRowLocator> {
    let id_index = result
        .columns
        .iter()
        .position(|column| column.name == "id")
        .ok_or_else(|| IpcError::system_internal("ClickHouse CRUD 测试缺少 id 列", "id column"))?;
    let row = result
        .rows
        .iter()
        .find(|row| {
            row.get(id_index).is_some_and(|value| {
                value.as_u64() == Some(id)
                    || value.as_str().is_some_and(|value| value == id.to_string())
            })
        })
        .ok_or_else(|| {
            IpcError::system_internal("ClickHouse CRUD 测试缺少目标行", format!("id={id}"))
        })?;
    let parts = result
        .columns
        .iter()
        .enumerate()
        .filter(|(_, column)| {
            !matches!(
                column.data_category,
                crate::engine::types::ColumnDataCategory::Binary
                    | crate::engine::types::ColumnDataCategory::Structured
                    | crate::engine::types::ColumnDataCategory::Unknown
            )
        })
        .map(|(index, column)| TableRowKeyPart {
            column: column.name.clone(),
            value: row[index].clone(),
        })
        .collect::<Vec<_>>();
    Ok(TableRowLocator::RowSnapshot {
        parts,
        expected_matches: 1,
    })
}

fn cell(column: &str, value: impl serde::Serialize) -> TableCellChange {
    TableCellChange {
        column: column.to_string(),
        value: serde_json::to_value(value).expect("fixture scalar should serialize"),
    }
}

async fn execute_fixture(client: &Client, sql: &str) -> IpcResult<()> {
    client
        .query(sql)
        .execute()
        .await
        .map_err(|error| fixture_error("manage CRUD fixture", error))
}

fn fixture_error(operation: &str, error: clickhouse::error::Error) -> IpcError {
    IpcError::system_internal(format!("ClickHouse {operation} failed"), error.to_string())
}

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "\\`"))
}
