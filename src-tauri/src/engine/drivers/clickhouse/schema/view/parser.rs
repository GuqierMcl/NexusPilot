#![allow(dead_code)]

use crate::engine::types::{ContainerKind, ContainerRef};
use crate::error::{IpcError, IpcResult};

use super::super::create_types::ClickHouseCreateEngineTarget;
use super::{
    scan_view_query, ClickHouseMaterializedStorage, ClickHouseRefreshDefinition,
    ClickHouseRefreshMode, ClickHouseRefreshSettings, ClickHouseViewAddress,
    ClickHouseViewColumnDefinition, ClickHouseViewDefiner, ClickHouseViewFamily,
    ClickHouseViewFamilyDefinition, ClickHouseViewInterval, ClickHouseViewIntervalUnit,
    ClickHouseViewRuntimeSupport, ClickHouseViewSecurity, ClickHouseViewSqlSecurity,
    ClickHouseViewTypedColumn, ClickHouseWindowWatermark,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedClickHouseView {
    pub family: ClickHouseViewFamily,
    pub columns: ClickHouseViewColumnDefinition,
    pub query: String,
    pub security: ClickHouseViewSecurity,
    pub comment: Option<String>,
    pub family_definition: ClickHouseViewFamilyDefinition,
    pub unknown_clauses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WordPosition {
    normalized: String,
    start: usize,
    end: usize,
}

pub fn parse_clickhouse_view_create(
    canonical_create_query: &str,
    _support: &ClickHouseViewRuntimeSupport,
) -> IpcResult<ParsedClickHouseView> {
    let sql = canonical_create_query.trim();
    let words = top_level_words(sql)?;
    if words.first().map(|word| word.normalized.as_str()) != Some("create") {
        return Err(validation_error(
            "ClickHouse View definition must start with CREATE",
        ));
    }
    let view_word = words
        .iter()
        .position(|word| word.normalized == "view")
        .ok_or_else(|| validation_error("ClickHouse View definition is missing VIEW"))?;
    if view_word == 0 {
        return Err(validation_error(
            "ClickHouse View definition header is invalid",
        ));
    }

    let as_word = words
        .iter()
        .enumerate()
        .skip(view_word + 1)
        .find(|(_, word)| {
            word.normalized == "as" && scan_view_query(sql[word.end..].trim()).is_ok()
        })
        .map(|(index, _)| index)
        .ok_or_else(|| validation_error("ClickHouse View definition is missing AS query"))?;
    if as_word <= view_word {
        return Err(validation_error(
            "ClickHouse View definition header is invalid",
        ));
    }
    let query = sql[words[as_word].end..].trim();
    let query_facts = scan_view_query(query)?;

    let family_header = words[..view_word]
        .iter()
        .map(|word| word.normalized.as_str())
        .collect::<Vec<_>>();
    if !matches!(
        family_header.as_slice(),
        ["create"]
            | ["create", "or", "replace"]
            | ["create", "temporary"]
            | ["create", "materialized"]
            | ["create", "window"]
            | ["create", "live"]
    ) {
        return Err(validation_error(
            "ClickHouse View definition header is invalid",
        ));
    }
    let mut family = if family_header.contains(&"temporary") {
        ClickHouseViewFamily::Temporary
    } else if family_header.contains(&"materialized") {
        if words[view_word + 1..as_word]
            .iter()
            .any(|word| word.normalized == "refresh")
        {
            ClickHouseViewFamily::RefreshableMaterialized
        } else {
            ClickHouseViewFamily::Materialized
        }
    } else if family_header.contains(&"window") {
        ClickHouseViewFamily::Window
    } else if family_header.contains(&"live") {
        ClickHouseViewFamily::Live
    } else {
        ClickHouseViewFamily::Normal
    };
    if family == ClickHouseViewFamily::Normal && !query_facts.parameters.is_empty() {
        family = ClickHouseViewFamily::Parameterized;
    }

    let address_start = skip_ascii_space(sql.as_bytes(), words[view_word].end);
    let address_end = parse_qualified_identifier_end(sql, address_start)?;
    let after_address = skip_ascii_space(sql.as_bytes(), address_end);
    let options_end = words[as_word].start;
    if after_address > options_end {
        return Err(validation_error("ClickHouse View address is malformed"));
    }
    let (mut columns, options_start) = if sql.as_bytes().get(after_address) == Some(&b'(') {
        let end = matching_parenthesis_end(sql, after_address)?;
        if end > options_end {
            return Err(validation_error(
                "ClickHouse View column definition is malformed",
            ));
        }
        (
            parse_column_definition(&sql[after_address + 1..end - 1])?,
            skip_ascii_space(sql.as_bytes(), end),
        )
    } else {
        (ClickHouseViewColumnDefinition::None, after_address)
    };
    columns = match (family, columns) {
        (
            ClickHouseViewFamily::Normal
            | ClickHouseViewFamily::Parameterized
            | ClickHouseViewFamily::Live,
            ClickHouseViewColumnDefinition::Typed(columns),
        ) => ClickHouseViewColumnDefinition::Aliases(
            columns.into_iter().map(|column| column.name).collect(),
        ),
        (
            ClickHouseViewFamily::Temporary | ClickHouseViewFamily::Window,
            ClickHouseViewColumnDefinition::Aliases(_) | ClickHouseViewColumnDefinition::Typed(_),
        ) => ClickHouseViewColumnDefinition::None,
        (_, columns) => columns,
    };
    let options = sql[options_start..options_end].trim();
    let security = parse_security(options)?;
    let comment = parse_comment_option(options)?;

    let (family_definition, unknown_clauses) = match family {
        ClickHouseViewFamily::Normal => (ClickHouseViewFamilyDefinition::Normal, Vec::new()),
        ClickHouseViewFamily::Parameterized => (
            ClickHouseViewFamilyDefinition::Parameterized {
                parameters: query_facts.parameters,
            },
            Vec::new(),
        ),
        ClickHouseViewFamily::Temporary => (ClickHouseViewFamilyDefinition::Temporary, Vec::new()),
        ClickHouseViewFamily::Materialized => (
            ClickHouseViewFamilyDefinition::Materialized {
                storage: parse_materialized_storage(options)?,
                populate: contains_word(options, "populate")?,
            },
            Vec::new(),
        ),
        ClickHouseViewFamily::RefreshableMaterialized => (
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                storage: parse_materialized_storage(options)?,
                refresh: parse_refresh_definition(options)?,
                append: contains_word(options, "append")?,
                empty: contains_word(options, "empty")?,
            },
            Vec::new(),
        ),
        ClickHouseViewFamily::Window => {
            let time_window_function = query_facts
                .top_level_function_calls
                .iter()
                .find(|function| {
                    matches!(
                        function.as_str(),
                        "tumble" | "hop" | "tumblingwindow" | "hoppingwindow"
                    )
                })
                .cloned()
                .unwrap_or_default();
            (
                ClickHouseViewFamilyDefinition::Window {
                    destination: parse_to_table(options)?,
                    inner_engine: parse_keyword_value(options, &["inner", "engine"]),
                    result_engine: parse_keyword_value(options, &["engine"]),
                    watermark: parse_window_watermark(options)?,
                    allowed_lateness: parse_window_allowed_lateness(options),
                    populate: contains_word(options, "populate")?,
                    time_window_function,
                },
                Vec::new(),
            )
        }
        ClickHouseViewFamily::Live => {
            let (timeout_seconds, refresh_seconds, unknown) = parse_live_options(options)?;
            (
                ClickHouseViewFamilyDefinition::Live {
                    timeout_seconds,
                    refresh_seconds,
                    canonical_legacy_options: unknown.clone(),
                },
                unknown,
            )
        }
    };

    Ok(ParsedClickHouseView {
        family,
        columns,
        query: query.trim_end_matches(';').trim_end().to_string(),
        security,
        comment,
        family_definition,
        unknown_clauses,
    })
}

fn top_level_words(sql: &str) -> IpcResult<Vec<WordPosition>> {
    let bytes = sql.as_bytes();
    let mut words = Vec::new();
    let mut depth = 0u32;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => index = skip_quoted(bytes, index, bytes[index])?,
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = skip_line_comment(bytes, index + 2)
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2)?
            }
            b'(' => {
                depth += 1;
                index += 1;
            }
            b')' => {
                if depth == 0 {
                    return Err(validation_error(
                        "ClickHouse View definition has unbalanced delimiters",
                    ));
                }
                depth -= 1;
                index += 1;
            }
            byte if is_word_start(byte) => {
                let start = index;
                index += 1;
                while bytes.get(index).is_some_and(|byte| is_word_continue(*byte)) {
                    index += 1;
                }
                if depth == 0 {
                    words.push(WordPosition {
                        normalized: sql[start..index].to_ascii_lowercase(),
                        start,
                        end: index,
                    });
                }
            }
            byte if byte.is_ascii_digit() && depth == 0 => {
                let start = index;
                index += 1;
                while bytes.get(index).is_some_and(u8::is_ascii_digit) {
                    index += 1;
                }
                words.push(WordPosition {
                    normalized: sql[start..index].to_string(),
                    start,
                    end: index,
                });
            }
            _ => index += 1,
        }
    }
    if depth != 0 {
        return Err(validation_error(
            "ClickHouse View definition has unbalanced delimiters",
        ));
    }
    Ok(words)
}

fn parse_column_definition(input: &str) -> IpcResult<ClickHouseViewColumnDefinition> {
    let entries = split_top_level(input, b',')?;
    if entries.is_empty() {
        return Err(validation_error(
            "ClickHouse View column definition cannot be empty",
        ));
    }
    let mut aliases = Vec::new();
    let mut typed = Vec::new();
    for entry in entries {
        let trimmed = entry.trim();
        let end = parse_identifier_end(trimmed, 0)?;
        let name = decode_identifier(&trimmed[..end])?;
        let tail = trimmed[end..].trim();
        if tail.is_empty() {
            aliases.push(name);
        } else {
            typed.push(ClickHouseViewTypedColumn {
                name,
                type_name: tail.to_string(),
            });
        }
    }
    if !aliases.is_empty() && !typed.is_empty() {
        return Err(validation_error(
            "ClickHouse View columns cannot mix aliases and typed definitions",
        ));
    }
    if typed.is_empty() {
        Ok(ClickHouseViewColumnDefinition::Aliases(aliases))
    } else {
        Ok(ClickHouseViewColumnDefinition::Typed(typed))
    }
}

fn parse_security(options: &str) -> IpcResult<ClickHouseViewSecurity> {
    let words = top_level_words(options)?;
    let mut definer = None;
    let mut sql_security = None;
    for (index, word) in words.iter().enumerate() {
        if word.normalized == "definer"
            && !(index >= 2
                && words[index - 2].normalized == "sql"
                && words[index - 1].normalized == "security")
        {
            let value = options[word.end..]
                .trim_start()
                .strip_prefix('=')
                .map(str::trim_start)
                .and_then(|tail| tail.split_whitespace().next())
                .ok_or_else(|| validation_error("ClickHouse View DEFINER is malformed"))?;
            definer = Some(if value.eq_ignore_ascii_case("current_user") {
                ClickHouseViewDefiner::CurrentUser
            } else {
                ClickHouseViewDefiner::NamedUser(trim_quotes(value).to_string())
            });
        }
        if word.normalized == "sql"
            && words.get(index + 1).map(|next| next.normalized.as_str()) == Some("security")
        {
            sql_security = Some(
                match words.get(index + 2).map(|next| next.normalized.as_str()) {
                    Some("definer") => ClickHouseViewSqlSecurity::Definer,
                    Some("invoker") => ClickHouseViewSqlSecurity::Invoker,
                    Some("none") => ClickHouseViewSqlSecurity::None,
                    _ => {
                        return Err(validation_error(
                            "ClickHouse View SQL SECURITY is malformed",
                        ));
                    }
                },
            );
        }
    }
    Ok(ClickHouseViewSecurity {
        definer,
        sql_security,
    })
}

fn parse_comment_option(options: &str) -> IpcResult<Option<String>> {
    let words = top_level_words(options)?;
    let Some(comment) = words.iter().find(|word| word.normalized == "comment") else {
        return Ok(None);
    };
    let start = skip_ascii_space(options.as_bytes(), comment.end);
    if options.as_bytes().get(start) != Some(&b'\'') {
        return Err(validation_error("ClickHouse View COMMENT is malformed"));
    }
    let end = skip_quoted(options.as_bytes(), start, b'\'')?;
    decode_string_literal(&options[start + 1..end - 1]).map(Some)
}

fn parse_materialized_storage(options: &str) -> IpcResult<ClickHouseMaterializedStorage> {
    if let Some(target) = parse_to_table(options)? {
        return Ok(ClickHouseMaterializedStorage::ToTable {
            target,
            target_columns: parse_to_target_columns(options)?,
        });
    }
    let engine = parse_keyword_value(options, &["engine"])
        .ok_or_else(|| validation_error("ClickHouse materialized View storage is required"))?;
    Ok(ClickHouseMaterializedStorage::InnerTable {
        engine: ClickHouseCreateEngineTarget {
            family: engine,
            arguments: Vec::new(),
        },
        order_by: parse_clause_expression(options, &["order", "by"])
            .unwrap_or_else(|| "tuple()".to_string()),
        partition_by: parse_clause_expression(options, &["partition", "by"]),
        settings: Vec::new(),
    })
}

fn parse_to_target_columns(options: &str) -> IpcResult<Vec<String>> {
    let words = top_level_words(options)?;
    let Some(to) = words.iter().find(|word| word.normalized == "to") else {
        return Ok(Vec::new());
    };
    let target_start = skip_ascii_space(options.as_bytes(), to.end);
    let target_end = parse_qualified_identifier_end(options, target_start)?;
    let columns_start = skip_ascii_space(options.as_bytes(), target_end);
    if options.as_bytes().get(columns_start) != Some(&b'(') {
        return Ok(Vec::new());
    }
    let columns_end = matching_parenthesis_end(options, columns_start)?;
    match parse_column_definition(&options[columns_start + 1..columns_end - 1])? {
        ClickHouseViewColumnDefinition::Aliases(columns) => Ok(columns),
        ClickHouseViewColumnDefinition::None => Ok(Vec::new()),
        ClickHouseViewColumnDefinition::Typed(columns) => {
            Ok(columns.into_iter().map(|column| column.name).collect())
        }
    }
}

fn parse_to_table(options: &str) -> IpcResult<Option<ContainerRef>> {
    let words = top_level_words(options)?;
    let Some(to) = words.iter().find(|word| word.normalized == "to") else {
        return Ok(None);
    };
    let start = skip_ascii_space(options.as_bytes(), to.end);
    let end = parse_qualified_identifier_end(options, start)?;
    let parts = split_qualified_identifier(&options[start..end])?;
    let container = match parts.as_slice() {
        [table] => ContainerRef {
            kind: ContainerKind::Table,
            group_type: None,
            database: None,
            schema: None,
            table: Some(table.clone()),
            column: None,
            object_name: None,
            db_index: None,
            key: None,
            pattern: None,
        },
        [database, table] => ContainerRef::table(ContainerKind::Table, database, None, table),
        _ => {
            return Err(validation_error(
                "ClickHouse materialized View TO target is malformed",
            ));
        }
    };
    Ok(Some(container))
}

fn parse_refresh_definition(options: &str) -> IpcResult<ClickHouseRefreshDefinition> {
    let words = top_level_words(options)?;
    let refresh = words
        .iter()
        .position(|word| word.normalized == "refresh")
        .ok_or_else(|| validation_error("Refreshable materialized View requires REFRESH"))?;
    let mode = match words.get(refresh + 1).map(|word| word.normalized.as_str()) {
        Some("every") => ClickHouseRefreshMode::Every,
        Some("after") => ClickHouseRefreshMode::After,
        Some("depends")
            if words.get(refresh + 2).map(|word| word.normalized.as_str()) == Some("only") =>
        {
            ClickHouseRefreshMode::DependsOnly
        }
        _ => {
            return Err(validation_error(
                "Refreshable materialized View mode is invalid",
            ))
        }
    };
    let interval = if mode == ClickHouseRefreshMode::DependsOnly {
        None
    } else {
        Some(parse_interval_words(&words, refresh + 2)?)
    };
    Ok(ClickHouseRefreshDefinition {
        mode,
        interval,
        offset: parse_interval_after(options, &["offset"]),
        randomize_for: parse_interval_after(options, &["randomize", "for"]),
        dependencies: parse_refresh_dependencies(options)?,
        settings: parse_refresh_settings(options)?,
    })
}

fn parse_refresh_dependencies(options: &str) -> IpcResult<Vec<ClickHouseViewAddress>> {
    let words = top_level_words(options)?;
    let Some(depends) = words.iter().position(|word| {
        word.normalized == "depends"
            && words
                .get(
                    words
                        .iter()
                        .position(|candidate| candidate.start == word.start)
                        .unwrap()
                        + 1,
                )
                .map(|next| next.normalized.as_str())
                == Some("on")
    }) else {
        return Ok(Vec::new());
    };
    let on = &words[depends + 1];
    let end = words
        .iter()
        .skip(depends + 2)
        .find(|word| {
            matches!(
                word.normalized.as_str(),
                "settings" | "append" | "to" | "engine" | "empty" | "definer" | "sql" | "comment"
            )
        })
        .map(|word| word.start)
        .unwrap_or(options.len());
    split_top_level(&options[on.end..end], b',')?
        .into_iter()
        .map(|entry| {
            let entry = entry.trim();
            let address_end = parse_qualified_identifier_end(entry, 0)?;
            if !entry[address_end..].trim().is_empty() {
                return Err(validation_error(
                    "ClickHouse refresh dependency is malformed",
                ));
            }
            match split_qualified_identifier(&entry[..address_end])?.as_slice() {
                [name] => Ok(ClickHouseViewAddress {
                    database: None,
                    name: name.clone(),
                    object_kind: ContainerKind::View,
                }),
                [database, name] => Ok(ClickHouseViewAddress {
                    database: Some(database.clone()),
                    name: name.clone(),
                    object_kind: ContainerKind::View,
                }),
                _ => Err(validation_error(
                    "ClickHouse refresh dependency is malformed",
                )),
            }
        })
        .collect()
}

fn parse_refresh_settings(options: &str) -> IpcResult<ClickHouseRefreshSettings> {
    let words = top_level_words(options)?;
    let refresh = words
        .iter()
        .position(|word| word.normalized == "refresh")
        .ok_or_else(|| validation_error("Refreshable materialized View requires REFRESH"))?;
    let storage_boundary = words
        .iter()
        .skip(refresh + 1)
        .find(|word| {
            matches!(
                word.normalized.as_str(),
                "append" | "to" | "engine" | "empty" | "definer" | "sql" | "comment"
            )
        })
        .map(|word| word.start)
        .unwrap_or(options.len());
    let Some(settings) = words
        .iter()
        .skip(refresh + 1)
        .find(|word| word.normalized == "settings" && word.start < storage_boundary)
    else {
        return Ok(ClickHouseRefreshSettings {
            refresh_retries: None,
            refresh_retry_initial_backoff_ms: None,
            refresh_retry_max_backoff_ms: None,
            all_replicas: None,
        });
    };
    let end = words
        .iter()
        .find(|word| {
            word.start > settings.end
                && matches!(
                    word.normalized.as_str(),
                    "append" | "to" | "engine" | "empty" | "definer" | "sql" | "comment"
                )
        })
        .map(|word| word.start)
        .unwrap_or(options.len());
    let mut parsed = ClickHouseRefreshSettings {
        refresh_retries: None,
        refresh_retry_initial_backoff_ms: None,
        refresh_retry_max_backoff_ms: None,
        all_replicas: None,
    };
    for entry in split_top_level(&options[settings.end..end], b',')? {
        let (name, value) = entry
            .split_once('=')
            .ok_or_else(|| validation_error("ClickHouse refresh setting is malformed"))?;
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "refresh_retries" => parsed.refresh_retries = Some(parse_refresh_u64(value)?),
            "refresh_retry_initial_backoff_ms" => {
                parsed.refresh_retry_initial_backoff_ms = Some(parse_refresh_u64(value)?)
            }
            "refresh_retry_max_backoff_ms" => {
                parsed.refresh_retry_max_backoff_ms = Some(parse_refresh_u64(value)?)
            }
            "all_replicas" => {
                parsed.all_replicas = Some(match value.to_ascii_lowercase().as_str() {
                    "0" | "false" => false,
                    "1" | "true" => true,
                    _ => {
                        return Err(validation_error(
                            "ClickHouse all_replicas setting is malformed",
                        ));
                    }
                })
            }
            _ => {
                return Err(validation_error(
                    "ClickHouse refresh setting is not modeled",
                ));
            }
        }
    }
    Ok(parsed)
}

fn parse_refresh_u64(value: &str) -> IpcResult<u64> {
    value
        .parse::<u64>()
        .map_err(|_| validation_error("ClickHouse refresh setting is malformed"))
}

fn parse_window_watermark(options: &str) -> IpcResult<ClickHouseWindowWatermark> {
    let words = top_level_words(options)?;
    let Some(index) = words.iter().position(|word| word.normalized == "watermark") else {
        return Ok(ClickHouseWindowWatermark::None);
    };
    let tail = trim_option_equals(&options[words[index].end..]);
    if strip_ascii_case_prefix(tail, "STRICTLY_ASCENDING").is_some()
        || strip_ascii_case_prefix(tail, "STRICTLY ASCENDING").is_some()
    {
        Ok(ClickHouseWindowWatermark::StrictlyAscending)
    } else if strip_ascii_case_prefix(tail, "ASCENDING").is_some() {
        Ok(ClickHouseWindowWatermark::Ascending)
    } else if strip_ascii_case_prefix(tail, "INTERVAL").is_some()
        || strip_ascii_case_prefix(tail, "BOUNDED").is_some()
    {
        Ok(ClickHouseWindowWatermark::Bounded(
            parse_window_interval_expression(tail)?,
        ))
    } else {
        Err(validation_error(
            "ClickHouse Window View WATERMARK is invalid",
        ))
    }
}

fn parse_window_allowed_lateness(options: &str) -> Option<ClickHouseViewInterval> {
    let words = top_level_words(options).ok()?;
    let end = words
        .iter()
        .position(|word| word.normalized == "allowed_lateness")
        .map(|index| words[index].end)
        .or_else(|| {
            words
                .windows(2)
                .position(|window| {
                    window[0].normalized == "allowed" && window[1].normalized == "lateness"
                })
                .map(|index| words[index + 1].end)
        })?;
    parse_window_interval_expression(trim_option_equals(&options[end..])).ok()
}

fn parse_window_interval_expression(input: &str) -> IpcResult<ClickHouseViewInterval> {
    let mut tail = input.trim_start();
    if let Some(rest) = strip_ascii_case_prefix(tail, "BOUNDED") {
        tail = rest.trim_start();
    }
    if let Some(rest) = strip_ascii_case_prefix(tail, "INTERVAL") {
        tail = rest.trim_start();
    }
    let (value, rest) = if tail.as_bytes().first() == Some(&b'\'') {
        let end = skip_quoted(tail.as_bytes(), 0, b'\'')?;
        (&tail[1..end - 1], &tail[end..])
    } else {
        let end = tail
            .bytes()
            .position(|byte| !byte.is_ascii_digit())
            .unwrap_or(tail.len());
        (&tail[..end], &tail[end..])
    };
    let value = value
        .parse::<u64>()
        .map_err(|_| validation_error("ClickHouse View interval value is invalid"))?;
    let unit_end = rest
        .trim_start()
        .bytes()
        .position(|byte| !is_word_continue(byte))
        .unwrap_or(rest.trim_start().len());
    let unit = &rest.trim_start()[..unit_end];
    let unit = match unit.to_ascii_lowercase().as_str() {
        "second" | "seconds" => ClickHouseViewIntervalUnit::Second,
        "minute" | "minutes" => ClickHouseViewIntervalUnit::Minute,
        "hour" | "hours" => ClickHouseViewIntervalUnit::Hour,
        "day" | "days" => ClickHouseViewIntervalUnit::Day,
        "week" | "weeks" => ClickHouseViewIntervalUnit::Week,
        "month" | "months" => ClickHouseViewIntervalUnit::Month,
        "year" | "years" => ClickHouseViewIntervalUnit::Year,
        _ => return Err(validation_error("ClickHouse View interval unit is invalid")),
    };
    Ok(ClickHouseViewInterval { value, unit })
}

fn trim_option_equals(input: &str) -> &str {
    input
        .trim_start()
        .strip_prefix('=')
        .unwrap_or(input.trim_start())
        .trim_start()
}

fn strip_ascii_case_prefix<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    input
        .get(..prefix.len())
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .then(|| &input[prefix.len()..])
}

fn parse_live_options(options: &str) -> IpcResult<(Option<u64>, Option<u64>, Vec<String>)> {
    let words = top_level_words(options)?;
    let mut timeout = None;
    let mut refresh = None;
    let mut consumed_end = 0usize;
    let mut index = 0usize;
    if words.get(index).map(|word| word.normalized.as_str()) == Some("with") {
        consumed_end = words[index].end;
        index += 1;
    }
    while index < words.len() {
        if words[index].normalized == "and" {
            consumed_end = words[index].end;
            index += 1;
            continue;
        }
        let slot = match words[index].normalized.as_str() {
            "timeout" => &mut timeout,
            "refresh" => &mut refresh,
            _ => break,
        };
        let value_word = words
            .get(index + 1)
            .ok_or_else(|| validation_error("ClickHouse Live View option is malformed"))?;
        *slot = Some(
            value_word
                .normalized
                .parse::<u64>()
                .map_err(|_| validation_error("ClickHouse Live View option is malformed"))?,
        );
        consumed_end = value_word.end;
        index += 2;
    }
    let unknown = options[consumed_end..].trim();
    Ok((
        timeout,
        refresh,
        (!unknown.is_empty())
            .then(|| unknown.to_string())
            .into_iter()
            .collect(),
    ))
}

fn contains_word(input: &str, expected: &str) -> IpcResult<bool> {
    Ok(top_level_words(input)?
        .iter()
        .any(|word| word.normalized == expected))
}

fn parse_keyword_value(options: &str, keyword: &[&str]) -> Option<String> {
    let words = top_level_words(options).ok()?;
    let index = words.windows(keyword.len()).position(|window| {
        window
            .iter()
            .zip(keyword)
            .all(|(word, expected)| word.normalized == *expected)
    })?;
    let value = words.get(index + keyword.len())?;
    Some(trim_quotes(&options[value.start..value.end]).to_string())
}

fn parse_clause_expression(options: &str, keyword: &[&str]) -> Option<String> {
    let words = top_level_words(options).ok()?;
    let index = words.windows(keyword.len()).position(|window| {
        window
            .iter()
            .zip(keyword)
            .all(|(word, expected)| word.normalized == *expected)
    })?;
    let value_start = skip_ascii_space(options.as_bytes(), words[index + keyword.len() - 1].end);
    let terminators = [
        "partition",
        "order",
        "settings",
        "populate",
        "to",
        "refresh",
        "append",
        "empty",
        "watermark",
        "allowed",
        "inner",
        "engine",
        "comment",
        "definer",
        "sql",
    ];
    let value_end = words
        .iter()
        .skip(index + keyword.len())
        .find(|word| word.start > value_start && terminators.contains(&word.normalized.as_str()))
        .map(|word| word.start)
        .unwrap_or(options.len());
    let expression = options[value_start..value_end].trim();
    (!expression.is_empty()).then(|| expression.to_string())
}

fn parse_interval_after(options: &str, keyword: &[&str]) -> Option<ClickHouseViewInterval> {
    let words = top_level_words(options).ok()?;
    let index = words.windows(keyword.len()).position(|window| {
        window
            .iter()
            .zip(keyword)
            .all(|(word, expected)| word.normalized == *expected)
    })?;
    parse_interval_words(&words, index + keyword.len()).ok()
}

fn parse_interval_words(words: &[WordPosition], index: usize) -> IpcResult<ClickHouseViewInterval> {
    let value = words
        .get(index)
        .ok_or_else(|| validation_error("ClickHouse View interval is missing"))?
        .normalized
        .parse::<u64>()
        .map_err(|_| validation_error("ClickHouse View interval value is invalid"))?;
    let unit = match words.get(index + 1).map(|word| word.normalized.as_str()) {
        Some("second" | "seconds") => ClickHouseViewIntervalUnit::Second,
        Some("minute" | "minutes") => ClickHouseViewIntervalUnit::Minute,
        Some("hour" | "hours") => ClickHouseViewIntervalUnit::Hour,
        Some("day" | "days") => ClickHouseViewIntervalUnit::Day,
        Some("week" | "weeks") => ClickHouseViewIntervalUnit::Week,
        Some("month" | "months") => ClickHouseViewIntervalUnit::Month,
        Some("year" | "years") => ClickHouseViewIntervalUnit::Year,
        _ => return Err(validation_error("ClickHouse View interval unit is invalid")),
    };
    Ok(ClickHouseViewInterval { value, unit })
}

fn parse_qualified_identifier_end(input: &str, start: usize) -> IpcResult<usize> {
    let mut index = parse_identifier_end(input, start)?;
    loop {
        let spaced = skip_ascii_space(input.as_bytes(), index);
        if input.as_bytes().get(spaced) != Some(&b'.') {
            return Ok(index);
        }
        index = skip_ascii_space(input.as_bytes(), spaced + 1);
        index = parse_identifier_end(input, index)?;
    }
}

fn parse_identifier_end(input: &str, start: usize) -> IpcResult<usize> {
    let bytes = input.as_bytes();
    match bytes.get(start).copied() {
        Some(quote @ (b'`' | b'"')) => skip_quoted(bytes, start, quote),
        Some(byte) if is_word_start(byte) => {
            let mut index = start + 1;
            while bytes.get(index).is_some_and(|byte| is_word_continue(*byte)) {
                index += 1;
            }
            Ok(index)
        }
        _ => Err(validation_error("ClickHouse View identifier is malformed")),
    }
}

fn split_qualified_identifier(input: &str) -> IpcResult<Vec<String>> {
    split_top_level(input, b'.')?
        .into_iter()
        .map(|part| decode_identifier(part.trim()))
        .collect()
}

fn decode_identifier(input: &str) -> IpcResult<String> {
    let trimmed = input.trim();
    if trimmed.len() >= 2
        && matches!(trimmed.as_bytes()[0], b'`' | b'"')
        && trimmed.as_bytes()[0] == trimmed.as_bytes()[trimmed.len() - 1]
    {
        let quote = trimmed.as_bytes()[0] as char;
        return Ok(trimmed[1..trimmed.len() - 1]
            .replace(&format!("{quote}{quote}"), &quote.to_string())
            .replace(&format!("\\{quote}"), &quote.to_string()));
    }
    if !trimmed.is_empty() && trimmed.bytes().all(is_word_continue) {
        Ok(trimmed.to_string())
    } else {
        Err(validation_error("ClickHouse View identifier is malformed"))
    }
}

fn matching_parenthesis_end(input: &str, start: usize) -> IpcResult<usize> {
    let bytes = input.as_bytes();
    let mut depth = 0u32;
    let mut index = start;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => index = skip_quoted(bytes, index, bytes[index])?,
            b'(' => {
                depth += 1;
                index += 1;
            }
            b')' => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return Ok(index);
                }
            }
            _ => index += 1,
        }
    }
    Err(validation_error(
        "ClickHouse View column definition is unclosed",
    ))
}

fn split_top_level(input: &str, delimiter: u8) -> IpcResult<Vec<&str>> {
    let bytes = input.as_bytes();
    let mut result = Vec::new();
    let mut depth = 0u32;
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => index = skip_quoted(bytes, index, bytes[index])?,
            b'(' | b'[' => {
                depth += 1;
                index += 1;
            }
            b')' | b']' => {
                if depth == 0 {
                    return Err(validation_error(
                        "ClickHouse View definition has unbalanced delimiters",
                    ));
                }
                depth -= 1;
                index += 1;
            }
            byte if byte == delimiter && depth == 0 => {
                result.push(&input[start..index]);
                start = index + 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    if depth != 0 {
        return Err(validation_error(
            "ClickHouse View definition has unbalanced delimiters",
        ));
    }
    result.push(&input[start..]);
    Ok(result
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect())
}

fn skip_quoted(bytes: &[u8], start: usize, quote: u8) -> IpcResult<usize> {
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            index = (index + 2).min(bytes.len());
        } else if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
            } else {
                return Ok(index + 1);
            }
        } else {
            index += 1;
        }
    }
    Err(validation_error(
        "ClickHouse View definition contains an unclosed quoted token",
    ))
}

fn decode_string_literal(input: &str) -> IpcResult<String> {
    let mut output = String::new();
    let mut chars = input.chars();
    while let Some(character) = chars.next() {
        if character == '\\' {
            let escaped = chars
                .next()
                .ok_or_else(|| validation_error("ClickHouse View string literal is malformed"))?;
            output.push(match escaped {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                '\\' => '\\',
                '\'' => '\'',
                other => other,
            });
        } else if character == '\'' && chars.as_str().starts_with('\'') {
            chars.next();
            output.push('\'');
        } else {
            output.push(character);
        }
    }
    Ok(output)
}

fn skip_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && !matches!(bytes[index], b'\n' | b'\r') {
        index += 1;
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> IpcResult<usize> {
    while index + 1 < bytes.len() {
        if bytes[index] == b'*' && bytes[index + 1] == b'/' {
            return Ok(index + 2);
        }
        index += 1;
    }
    Err(validation_error(
        "ClickHouse View definition contains an unclosed block comment",
    ))
}

fn skip_ascii_space(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
}

fn trim_quotes(input: &str) -> &str {
    input.trim_matches(['\'', '"', '`'])
}

fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_word_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn validation_error(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::drivers::clickhouse::schema::{
        ClickHouseClusterDdlSupport, ClickHouseMaterializedStorage, ClickHouseSupportState,
        ClickHouseViewAddress, ClickHouseViewFamily, ClickHouseViewFamilyDefinition,
        ClickHouseViewFamilySupport, ClickHouseViewOperationSupport, ClickHouseViewRuntimeSupport,
    };

    fn support() -> ClickHouseViewRuntimeSupport {
        let operation = ClickHouseViewOperationSupport {
            state: ClickHouseSupportState::Supported,
            reason: None,
        };
        let family = ClickHouseViewFamilySupport {
            describe: operation.clone(),
            create: operation.clone(),
            alter: operation.clone(),
            rename: operation.clone(),
            drop: operation,
        };
        ClickHouseViewRuntimeSupport {
            server_version: "25.3.1".to_string(),
            database_engine: Some("Atomic".to_string()),
            normal: family.clone(),
            parameterized: family.clone(),
            temporary: family.clone(),
            materialized: family.clone(),
            refreshable_materialized: family.clone(),
            window: family.clone(),
            live: family,
            cluster_ddl: ClickHouseClusterDdlSupport {
                discoverable: false,
                executable: false,
                observable: false,
                drift_verifiable: false,
            },
            support_revision: "a".repeat(64),
        }
    }

    #[test]
    fn parser_classifies_normal_parameterized_and_temporary_views() {
        let normal = parse_clickhouse_view_create(
            "CREATE VIEW `analytics`.`normal_view` SQL SECURITY INVOKER COMMENT 'normal' AS SELECT 1",
            &support(),
        )
        .unwrap();
        assert_eq!(normal.family, ClickHouseViewFamily::Normal);
        assert_eq!(normal.comment.as_deref(), Some("normal"));
        assert_eq!(
            normal.security.sql_security,
            Some(crate::engine::drivers::clickhouse::schema::ClickHouseViewSqlSecurity::Invoker)
        );

        let canonical_normal = parse_clickhouse_view_create(
            "CREATE VIEW `analytics`.`canonical_view` (`id` UInt64, `value` String) AS SELECT id, value FROM analytics.events",
            &support(),
        )
        .unwrap();
        assert_eq!(
            canonical_normal.columns,
            ClickHouseViewColumnDefinition::Aliases(vec!["id".to_string(), "value".to_string(),])
        );

        let parameterized = parse_clickhouse_view_create(
            "CREATE VIEW `analytics`.`parameterized_view` AS SELECT {tenant:UInt64}",
            &support(),
        )
        .unwrap();
        assert_eq!(parameterized.family, ClickHouseViewFamily::Parameterized);
        assert!(matches!(
            parameterized.family_definition,
            ClickHouseViewFamilyDefinition::Parameterized { .. }
        ));

        let temporary = parse_clickhouse_view_create(
            "CREATE TEMPORARY VIEW `temporary_view` AS WITH 1 AS one SELECT one",
            &support(),
        )
        .unwrap();
        assert_eq!(temporary.family, ClickHouseViewFamily::Temporary);
    }

    #[test]
    fn parser_keeps_typed_materialized_and_refreshable_storage() {
        let materialized = parse_clickhouse_view_create(
            "CREATE MATERIALIZED VIEW `analytics`.`events_mv` (`tenant` UInt64) \
             TO `analytics`.`events_sink` (`tenant` UInt64) AS SELECT tenant FROM analytics.events",
            &support(),
        )
        .unwrap();
        assert_eq!(materialized.family, ClickHouseViewFamily::Materialized);
        assert!(matches!(
            materialized.columns,
            crate::engine::drivers::clickhouse::schema::ClickHouseViewColumnDefinition::Typed(_)
        ));
        assert!(matches!(
            materialized.family_definition,
            ClickHouseViewFamilyDefinition::Materialized {
                storage: ClickHouseMaterializedStorage::ToTable { ref target_columns, .. },
                populate: false,
            } if target_columns == &["tenant".to_string()]
        ));

        let inner = parse_clickhouse_view_create(
            "CREATE MATERIALIZED VIEW `analytics`.`inner_mv` ENGINE = MergeTree ORDER BY tuple() AS SELECT id, value FROM analytics.events",
            &support(),
        )
        .unwrap();
        assert!(matches!(
            inner.family_definition,
            ClickHouseViewFamilyDefinition::Materialized {
                storage: ClickHouseMaterializedStorage::InnerTable { ref order_by, .. },
                populate: false,
            } if order_by == "tuple()"
        ));

        let refreshable = parse_clickhouse_view_create(
            "CREATE MATERIALIZED VIEW `analytics`.`refresh_mv` REFRESH EVERY 1 HOUR APPEND \
             TO `analytics`.`events_sink` AS SELECT count() FROM analytics.events",
            &support(),
        )
        .unwrap();
        assert_eq!(
            refreshable.family,
            ClickHouseViewFamily::RefreshableMaterialized
        );
        assert!(matches!(
            &refreshable.family_definition,
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                append: true,
                empty: false,
                refresh,
                ..
            } if refresh.interval.as_ref().is_some_and(|interval| {
                interval.value == 1
                    && interval.unit
                        == crate::engine::drivers::clickhouse::schema::ClickHouseViewIntervalUnit::Hour
            })
        ));
    }

    #[test]
    fn parser_restores_refreshable_dependencies_settings_and_security() {
        let refreshable = parse_clickhouse_view_create(
            "CREATE MATERIALIZED VIEW `analytics`.`refresh_mv` \
             REFRESH EVERY 1 HOUR OFFSET 1 MINUTE RANDOMIZE FOR 1 MINUTE \
             DEPENDS ON `analytics`.`dependency_view` \
             SETTINGS refresh_retries = 2, refresh_retry_initial_backoff_ms = 100, \
             refresh_retry_max_backoff_ms = 500, all_replicas = 0 \
             APPEND TO `analytics`.`events_sink` EMPTY \
             DEFINER = CURRENT_USER SQL SECURITY DEFINER \
             AS SELECT count() FROM analytics.events",
            &support(),
        )
        .unwrap();

        assert_eq!(
            refreshable.security,
            ClickHouseViewSecurity {
                definer: Some(ClickHouseViewDefiner::CurrentUser),
                sql_security: Some(ClickHouseViewSqlSecurity::Definer),
            }
        );
        assert!(matches!(
            refreshable.family_definition,
            ClickHouseViewFamilyDefinition::RefreshableMaterialized {
                refresh: ClickHouseRefreshDefinition {
                    dependencies,
                    settings: ClickHouseRefreshSettings {
                        refresh_retries: Some(2),
                        refresh_retry_initial_backoff_ms: Some(100),
                        refresh_retry_max_backoff_ms: Some(500),
                        all_replicas: Some(false),
                    },
                    ..
                },
                append: true,
                empty: true,
                ..
            } if dependencies == vec![ClickHouseViewAddress {
                database: Some("analytics".to_string()),
                name: "dependency_view".to_string(),
                object_kind: ContainerKind::View,
            }]
        ));
    }

    #[test]
    fn parser_classifies_window_and_preserves_unknown_live_options() {
        let window = parse_clickhouse_view_create(
            "CREATE WINDOW VIEW `analytics`.`window_view` WATERMARK=STRICTLY_ASCENDING \
             AS SELECT tumble(ts), count() FROM analytics.events GROUP BY tumble(ts)",
            &support(),
        )
        .unwrap();
        assert_eq!(window.family, ClickHouseViewFamily::Window);
        assert!(matches!(
            window.family_definition,
            ClickHouseViewFamilyDefinition::Window {
                watermark: crate::engine::drivers::clickhouse::schema::ClickHouseWindowWatermark::StrictlyAscending,
                ref time_window_function,
                ..
            } if time_window_function == "tumble"
        ));

        let bounded = parse_clickhouse_view_create(
            "CREATE WINDOW VIEW `analytics`.`bounded_window` \
             WATERMARK=INTERVAL '3' SECOND ALLOWED_LATENESS=INTERVAL '2' SECOND \
             AS SELECT tumble(ts), count() FROM analytics.events GROUP BY tumble(ts)",
            &support(),
        )
        .unwrap();
        assert!(matches!(
            bounded.family_definition,
            ClickHouseViewFamilyDefinition::Window {
                watermark: ClickHouseWindowWatermark::Bounded(ClickHouseViewInterval {
                    value: 3,
                    unit: ClickHouseViewIntervalUnit::Second,
                }),
                allowed_lateness: Some(ClickHouseViewInterval {
                    value: 2,
                    unit: ClickHouseViewIntervalUnit::Second,
                }),
                ..
            }
        ));

        let live = parse_clickhouse_view_create(
            "CREATE LIVE VIEW `analytics`.`live_view` WITH TIMEOUT 5 AND REFRESH 1 FUTURE OPTION \
             AS SELECT 1",
            &support(),
        )
        .unwrap();
        assert_eq!(live.family, ClickHouseViewFamily::Live);
        assert_eq!(live.unknown_clauses, vec!["FUTURE OPTION"]);
        assert!(matches!(
            live.family_definition,
            ClickHouseViewFamilyDefinition::Live {
                timeout_seconds: Some(5),
                refresh_seconds: Some(1),
                canonical_legacy_options,
            } if canonical_legacy_options == vec!["FUTURE OPTION"]
        ));
    }

    #[test]
    fn parser_rejects_non_create_and_unsafe_query_tails_without_echoing_sql() {
        for sql in [
            "SELECT 1",
            "CREATE TABLE view AS SELECT 1",
            "CREATE VIEW v AS SELECT 1 FORMAT JSON",
            "CREATE VIEW v AS SELECT 1; DROP TABLE secret_table",
        ] {
            let error = parse_clickhouse_view_create(sql, &support()).unwrap_err();
            assert!(!format!("{error:?}").contains("secret_table"));
        }
    }
}
