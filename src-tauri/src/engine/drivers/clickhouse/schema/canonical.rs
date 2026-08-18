use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{IpcError, IpcResult};

use super::types::{
    ClickHouseColumnDefaultKind, ClickHouseColumnSchema, ClickHouseProjectionSchema,
    ClickHouseSettingSchema, ClickHouseSkippingIndexSchema, ClickHouseTableSchema,
};

const REVISION_DOMAIN: &[u8] = b"nexpilot.clickhouse.table-schema.v1\0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalTableSchema<'a> {
    identity: CanonicalIdentity<'a>,
    engine: CanonicalEngine<'a>,
    columns: Vec<CanonicalColumn<'a>>,
    keys: CanonicalKeys<'a>,
    table_ttl: Option<&'a str>,
    comment: Option<&'a str>,
    settings: Vec<CanonicalSetting<'a>>,
    projections: Vec<CanonicalProjection<'a>>,
    skipping_indexes: Vec<CanonicalSkippingIndex<'a>>,
    canonical_create_query: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalIdentity<'a> {
    database: &'a str,
    name: &'a str,
    object_kind: &'a crate::engine::types::ContainerKind,
    uuid: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalEngine<'a> {
    family: &'a str,
    arguments: &'a [String],
    raw_expression: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalColumn<'a> {
    name: &'a str,
    type_name: &'a str,
    position: u64,
    default_kind: ClickHouseColumnDefaultKind,
    default_expression: Option<&'a str>,
    codec_expression: Option<&'a str>,
    ttl_expression: Option<&'a str>,
    comment: Option<&'a str>,
}

impl<'a> From<&'a ClickHouseColumnSchema> for CanonicalColumn<'a> {
    fn from(column: &'a ClickHouseColumnSchema) -> Self {
        Self {
            name: &column.name,
            type_name: &column.type_name,
            position: column.position,
            default_kind: column.default_kind,
            default_expression: column.default_expression.as_deref(),
            codec_expression: column.codec_expression.as_deref(),
            ttl_expression: column.ttl_expression.as_deref(),
            comment: column.comment.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalKeys<'a> {
    order_by: &'a str,
    partition_by: Option<&'a str>,
    primary_key: Option<&'a str>,
    sample_by: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSetting<'a> {
    name: &'a str,
    value: &'a str,
    explicit: bool,
}

impl<'a> From<&'a ClickHouseSettingSchema> for CanonicalSetting<'a> {
    fn from(setting: &'a ClickHouseSettingSchema) -> Self {
        Self {
            name: &setting.name,
            value: &setting.value,
            explicit: setting.explicit,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalProjection<'a> {
    name: &'a str,
    query: &'a str,
}

impl<'a> From<&'a ClickHouseProjectionSchema> for CanonicalProjection<'a> {
    fn from(projection: &'a ClickHouseProjectionSchema) -> Self {
        Self {
            name: &projection.name,
            query: &projection.query,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalSkippingIndex<'a> {
    name: &'a str,
    expression: &'a str,
    index_type: &'a str,
    type_arguments: &'a [String],
    granularity: Option<u64>,
}

impl<'a> From<&'a ClickHouseSkippingIndexSchema> for CanonicalSkippingIndex<'a> {
    fn from(index: &'a ClickHouseSkippingIndexSchema) -> Self {
        Self {
            name: &index.name,
            expression: &index.expression,
            index_type: &index.index_type,
            type_arguments: &index.type_arguments,
            granularity: index.granularity,
        }
    }
}

fn canonical_projection(schema: &ClickHouseTableSchema) -> CanonicalTableSchema<'_> {
    let mut settings = schema
        .settings
        .iter()
        .filter(|setting| setting.explicit)
        .collect::<Vec<_>>();
    settings.sort_by(|left, right| {
        (&left.name, &left.value, left.explicit).cmp(&(&right.name, &right.value, right.explicit))
    });

    let mut projections = schema.projections.iter().collect::<Vec<_>>();
    projections.sort_by(|left, right| (&left.name, &left.query).cmp(&(&right.name, &right.query)));

    let mut skipping_indexes = schema.skipping_indexes.iter().collect::<Vec<_>>();
    skipping_indexes.sort_by(|left, right| {
        (
            &left.name,
            &left.expression,
            &left.index_type,
            &left.type_arguments,
            left.granularity,
        )
            .cmp(&(
                &right.name,
                &right.expression,
                &right.index_type,
                &right.type_arguments,
                right.granularity,
            ))
    });

    CanonicalTableSchema {
        identity: CanonicalIdentity {
            database: &schema.identity.database,
            name: &schema.identity.name,
            object_kind: &schema.identity.object_kind,
            uuid: schema.identity.uuid.as_deref(),
        },
        engine: CanonicalEngine {
            family: &schema.engine.family,
            arguments: &schema.engine.arguments,
            raw_expression: &schema.engine.raw_expression,
        },
        columns: schema.columns.iter().map(CanonicalColumn::from).collect(),
        keys: CanonicalKeys {
            order_by: &schema.keys.order_by,
            partition_by: schema.keys.partition_by.as_deref(),
            primary_key: schema.keys.primary_key.as_deref(),
            sample_by: schema.keys.sample_by.as_deref(),
        },
        table_ttl: schema.table_ttl.as_deref(),
        comment: schema.comment.as_deref(),
        settings: settings.into_iter().map(CanonicalSetting::from).collect(),
        projections: projections
            .into_iter()
            .map(CanonicalProjection::from)
            .collect(),
        skipping_indexes: skipping_indexes
            .into_iter()
            .map(CanonicalSkippingIndex::from)
            .collect(),
        canonical_create_query: &schema.baseline.canonical_create_query,
    }
}

pub fn revision_hash(schema: &ClickHouseTableSchema) -> IpcResult<String> {
    let canonical = canonical_projection(schema);
    let bytes = serde_json::to_vec(&canonical).map_err(|error| {
        IpcError::system_internal(
            "Failed to canonicalize ClickHouse table schema",
            error.to_string(),
        )
    })?;

    let mut digest = Sha256::new();
    digest.update(REVISION_DOMAIN);
    digest.update(bytes);
    Ok(format!("{:x}", digest.finalize()))
}

pub fn refresh_revision(schema: &mut ClickHouseTableSchema) -> IpcResult<()> {
    schema.baseline.revision_hash = revision_hash(schema)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::drivers::clickhouse::schema::types::{
        fixture_schema, ClickHouseSchemaBlocker, ClickHouseSchemaEditabilityMode,
    };

    #[test]
    fn canonical_revision_is_stable_but_changes_with_semantics() {
        let first = fixture_schema();
        let second = fixture_schema();
        assert_eq!(
            revision_hash(&first).expect("first revision"),
            revision_hash(&second).expect("second revision")
        );

        let mut changed = fixture_schema();
        changed.keys.order_by = "(tenant_id, id, day)".to_string();
        assert_ne!(
            revision_hash(&first).expect("baseline revision"),
            revision_hash(&changed).expect("changed revision")
        );

        let mut reordered_columns = fixture_schema();
        reordered_columns.columns.reverse();
        assert_ne!(
            revision_hash(&first).expect("baseline revision"),
            revision_hash(&reordered_columns).expect("column order revision")
        );
    }

    #[test]
    fn canonical_revision_sorts_named_objects_and_excludes_editability() {
        let first = fixture_schema();
        let mut reordered = fixture_schema();
        reordered.settings.reverse();
        reordered.projections.reverse();
        reordered.skipping_indexes.reverse();
        reordered.editability.mode = ClickHouseSchemaEditabilityMode::Readonly;
        reordered
            .editability
            .blockers
            .push(ClickHouseSchemaBlocker {
                code: "parser_changed".to_string(),
                path: "engine".to_string(),
                message: "derived blocker".to_string(),
            });
        reordered.columns[0].editability.mode = ClickHouseSchemaEditabilityMode::Restricted;
        reordered.projections[0]
            .editability
            .blockers
            .push(ClickHouseSchemaBlocker {
                code: "projection_readonly".to_string(),
                path: "projections[0]".to_string(),
                message: "diagnostic only".to_string(),
            });
        reordered.skipping_indexes[0].editability.mode = ClickHouseSchemaEditabilityMode::Readonly;

        assert_eq!(
            revision_hash(&first).expect("baseline revision"),
            revision_hash(&reordered).expect("reordered revision")
        );
    }

    #[test]
    fn canonical_revision_ignores_server_defaults_but_keeps_opaque_create_semantics() {
        let first = fixture_schema();

        let mut with_server_default = fixture_schema();
        with_server_default.settings.push(ClickHouseSettingSchema {
            name: "server_default".to_string(),
            value: "first effective value".to_string(),
            explicit: false,
        });
        assert_eq!(
            revision_hash(&first).expect("baseline revision"),
            revision_hash(&with_server_default).expect("server-default revision")
        );

        let mut changed_create_query = fixture_schema();
        changed_create_query
            .baseline
            .canonical_create_query
            .push_str(" SETTINGS allow_experimental_feature = 1");
        assert_ne!(
            revision_hash(&first).expect("baseline revision"),
            revision_hash(&changed_create_query).expect("opaque CREATE revision")
        );
    }

    #[test]
    fn refresh_revision_writes_a_lowercase_sha256_hash() {
        let mut schema = fixture_schema();
        refresh_revision(&mut schema).expect("refresh revision");

        assert_eq!(schema.baseline.revision_hash.len(), 64);
        assert!(schema
            .baseline
            .revision_hash
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character)));
    }
}
