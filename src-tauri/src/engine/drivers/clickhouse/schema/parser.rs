use std::collections::{BTreeMap, BTreeSet};

use crate::error::{IpcError, IpcResult};

use super::{
    sql_scan::scan_table_clauses,
    types::{
        ClickHouseEngineSchema, ClickHouseKeySchema, ClickHouseSchemaBlocker,
        ClickHouseSettingSchema,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ParsedTableClauses {
    pub engine: ClickHouseEngineSchema,
    pub keys: ClickHouseKeySchema,
    pub table_ttl: Option<String>,
    pub settings: Vec<ClickHouseSettingSchema>,
    pub comment: Option<String>,
    pub column_names: Vec<String>,
    pub column_ttl_expressions: BTreeMap<String, Option<String>>,
    pub column_blockers: BTreeMap<String, Vec<ClickHouseSchemaBlocker>>,
    pub blockers: Vec<ClickHouseSchemaBlocker>,
}

pub(super) fn parse_table_clauses(sql: &str) -> IpcResult<ParsedTableClauses> {
    let scanned = scan_table_clauses(sql)?;
    let engine = parse_engine(&scanned.engine)?;
    let settings = parse_settings(scanned.settings.as_deref())?;
    let comment = scanned.comment.as_deref().map(parse_comment).transpose()?;
    let ParsedTableBody {
        column_names,
        column_ttl_expressions,
        column_blockers,
        mut blockers,
    } = parse_table_body(&scanned.table_body)?;

    blockers.extend(
        scanned
            .unknown_clauses
            .iter()
            .map(|unknown| ClickHouseSchemaBlocker {
                code: "unsupported_create_clause".to_string(),
                path: "createTable".to_string(),
                message: format!(
                    "Unsupported ClickHouse CREATE TABLE clause: {}",
                    unknown.raw
                ),
            }),
    );

    Ok(ParsedTableClauses {
        engine,
        keys: ClickHouseKeySchema {
            order_by: scanned.order_by,
            partition_by: scanned.partition_by,
            primary_key: scanned.primary_key,
            sample_by: scanned.sample_by,
        },
        table_ttl: scanned.table_ttl,
        settings,
        comment,
        column_names,
        column_ttl_expressions,
        column_blockers,
        blockers,
    })
}

pub(super) fn parse_engine(raw_expression: &str) -> IpcResult<ClickHouseEngineSchema> {
    let raw_expression = raw_expression.trim();
    let family_end = raw_expression
        .bytes()
        .position(|byte| byte == b'(' || byte.is_ascii_whitespace())
        .unwrap_or(raw_expression.len());
    let family = raw_expression[..family_end].trim();
    if family.is_empty()
        || !family
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(validation_error(
            "ClickHouse ENGINE must start with a valid engine family",
        ));
    }

    let remainder = raw_expression[family_end..].trim();
    let arguments = if remainder.is_empty() {
        Vec::new()
    } else {
        if !remainder.starts_with('(') || !remainder.ends_with(')') {
            return Err(validation_error(
                "ClickHouse ENGINE arguments must be enclosed by one balanced parenthesis pair",
            ));
        }
        split_top_level(&remainder[1..remainder.len() - 1], b',')?
    };

    Ok(ClickHouseEngineSchema {
        family: family.to_string(),
        arguments,
        raw_expression: raw_expression.to_string(),
    })
}

fn parse_settings(raw_settings: Option<&str>) -> IpcResult<Vec<ClickHouseSettingSchema>> {
    let Some(raw_settings) = raw_settings else {
        return Ok(Vec::new());
    };
    let mut seen_names = BTreeSet::new();
    let mut settings = Vec::new();

    for assignment in split_top_level(raw_settings, b',')? {
        let equals = find_top_level_delimiter(&assignment, b'=')?.ok_or_else(|| {
            validation_error(format!(
                "ClickHouse SETTINGS entry is missing '=': {assignment}"
            ))
        })?;
        let name = assignment[..equals].trim();
        let value = assignment[equals + 1..].trim();
        if name.is_empty() || value.is_empty() {
            return Err(validation_error(format!(
                "ClickHouse SETTINGS entry must contain a name and value: {assignment}"
            )));
        }
        if !seen_names.insert(name.to_string()) {
            return Err(validation_error(format!(
                "ClickHouse SETTINGS contains duplicate setting '{name}'"
            )));
        }
        settings.push(ClickHouseSettingSchema {
            name: name.to_string(),
            value: value.to_string(),
            explicit: true,
        });
    }

    Ok(settings)
}

fn parse_comment(raw_comment: &str) -> IpcResult<String> {
    let raw_comment = raw_comment.trim();
    let bytes = raw_comment.as_bytes();
    if bytes.first() != Some(&b'\'') {
        return Err(validation_error(
            "ClickHouse COMMENT must be a single-quoted string literal",
        ));
    }

    let mut value = Vec::with_capacity(bytes.len().saturating_sub(2));
    let mut index = 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let escaped = bytes.get(index + 1).copied().ok_or_else(|| {
                validation_error("ClickHouse COMMENT ends with an incomplete escape sequence")
            })?;
            match escaped {
                b'a' => value.push(0x07),
                b'b' => value.push(0x08),
                b'e' => value.push(0x1b),
                b'f' => value.push(0x0c),
                b'n' => value.push(b'\n'),
                b'r' => value.push(b'\r'),
                b't' => value.push(b'\t'),
                b'v' => value.push(0x0b),
                b'0' => value.push(0),
                b'\'' | b'"' | b'\\' => value.push(escaped),
                b'x' => {
                    let high = bytes.get(index + 2).copied().and_then(hex_value);
                    let low = bytes.get(index + 3).copied().and_then(hex_value);
                    let Some((high, low)) = high.zip(low) else {
                        return Err(validation_error(
                            "ClickHouse COMMENT contains an incomplete hexadecimal escape",
                        ));
                    };
                    value.push((high << 4) | low);
                    index += 4;
                    continue;
                }
                _ => {
                    return Err(validation_error(format!(
                        "ClickHouse COMMENT contains unsupported escape sequence \\{}",
                        char::from(escaped)
                    )))
                }
            }
            index += 2;
            continue;
        }
        if bytes[index] == b'\'' {
            if bytes.get(index + 1) == Some(&b'\'') {
                value.push(b'\'');
                index += 2;
                continue;
            }
            if raw_comment[index + 1..].trim().is_empty() {
                return String::from_utf8(value).map_err(|error| {
                    validation_error(format!("ClickHouse COMMENT is not valid UTF-8: {error}"))
                });
            }
            return Err(validation_error(
                "ClickHouse COMMENT contains trailing tokens after the string literal",
            ));
        }
        value.push(bytes[index]);
        index += 1;
    }

    Err(validation_error(
        "ClickHouse COMMENT contains an unclosed string literal",
    ))
}

struct ParsedTableBody {
    column_names: Vec<String>,
    column_ttl_expressions: BTreeMap<String, Option<String>>,
    column_blockers: BTreeMap<String, Vec<ClickHouseSchemaBlocker>>,
    blockers: Vec<ClickHouseSchemaBlocker>,
}

fn parse_table_body(table_body: &str) -> IpcResult<ParsedTableBody> {
    let mut column_names = Vec::new();
    let mut column_ttl_expressions = BTreeMap::new();
    let mut column_blockers = BTreeMap::new();
    let mut seen_names = BTreeSet::new();
    let mut blockers = Vec::new();

    for entry in split_top_level(table_body, b',')? {
        let (identifier, rest, quoted) = parse_identifier_prefix(&entry)?;
        if !quoted {
            let uppercase = identifier.to_ascii_uppercase();
            match uppercase.as_str() {
                "INDEX" | "PROJECTION" => continue,
                "CONSTRAINT" | "PRIMARY" => {
                    blockers.push(ClickHouseSchemaBlocker {
                        code: "unsupported_table_body_entry".to_string(),
                        path: "tableBody".to_string(),
                        message: format!(
                            "Unsupported ClickHouse CREATE TABLE body entry: {}",
                            entry.trim()
                        ),
                    });
                    continue;
                }
                _ => {}
            }
        }

        if rest.trim().is_empty() {
            return Err(validation_error(format!(
                "ClickHouse column '{identifier}' is missing a type expression"
            )));
        }
        if !seen_names.insert(identifier.clone()) {
            return Err(validation_error(format!(
                "ClickHouse CREATE TABLE contains duplicate column '{identifier}'"
            )));
        }
        let facts = parse_column_facts(&identifier, rest)?;
        column_ttl_expressions.insert(identifier.clone(), facts.ttl_expression);
        if !facts.blockers.is_empty() {
            column_blockers.insert(identifier.clone(), facts.blockers);
        }
        column_names.push(identifier);
    }

    Ok(ParsedTableBody {
        column_names,
        column_ttl_expressions,
        column_blockers,
        blockers,
    })
}

#[derive(Debug)]
struct ColumnWordToken {
    start: usize,
    end: usize,
    uppercase: String,
}

struct ParsedColumnFacts {
    ttl_expression: Option<String>,
    blockers: Vec<ClickHouseSchemaBlocker>,
}

fn parse_column_facts(column_name: &str, column_tail: &str) -> IpcResult<ParsedColumnFacts> {
    let words = collect_top_level_column_words(column_tail)?;
    let ttl_positions = words
        .iter()
        .enumerate()
        .filter(|(_, word)| word.uppercase == "TTL")
        .collect::<Vec<_>>();
    if ttl_positions.len() > 1 {
        return Err(validation_error(
            "ClickHouse column definition contains duplicate TTL clauses",
        ));
    }
    let ttl_expression = ttl_positions
        .first()
        .map(|(_, ttl)| {
            let expression = column_tail[ttl.end..].trim();
            if expression.is_empty() {
                Err(validation_error(
                    "ClickHouse column TTL clause has no expression",
                ))
            } else {
                Ok(expression.to_string())
            }
        })
        .transpose()?;

    let type_token = words.first().filter(|word| {
        column_tail[..word.start].trim().is_empty()
            && !is_supported_column_modifier(&word.uppercase)
    });
    let mut expression_context = false;
    let mut unsupported = BTreeSet::new();
    for word in &words {
        if type_token.is_some_and(|type_token| std::ptr::eq(word, type_token)) {
            continue;
        }
        match word.uppercase.as_str() {
            "DEFAULT" | "MATERIALIZED" | "ALIAS" | "EPHEMERAL" | "TTL" => {
                expression_context = true;
            }
            "COMMENT" | "CODEC" => expression_context = false,
            "STATISTICS" => {
                expression_context = false;
                unsupported.insert(word.uppercase.as_str());
            }
            _ if expression_context
                && (word_starts_column_expression_call(column_tail, word)
                    || is_column_expression_word(&word.uppercase)) => {}
            _ => {
                unsupported.insert(word.uppercase.as_str());
            }
        }
    }
    let blockers = unsupported
        .into_iter()
        .map(|modifier| ClickHouseSchemaBlocker {
            code: "unsupported_column_clause".to_string(),
            path: format!("columns.{column_name}"),
            message: format!(
                "ClickHouse column '{column_name}' contains unsupported clause '{modifier}'"
            ),
        })
        .collect();

    Ok(ParsedColumnFacts {
        ttl_expression,
        blockers,
    })
}

fn word_starts_column_expression_call(input: &str, word: &ColumnWordToken) -> bool {
    input
        .as_bytes()
        .get(word.end)
        .is_some_and(|byte| matches!(*byte, b'(' | b'['))
}

fn is_supported_column_modifier(word: &str) -> bool {
    matches!(
        word,
        "ALIAS" | "CODEC" | "COMMENT" | "DEFAULT" | "EPHEMERAL" | "MATERIALIZED" | "TTL"
    )
}

fn is_column_expression_word(word: &str) -> bool {
    matches!(
        word,
        "AND"
            | "AS"
            | "BETWEEN"
            | "BY"
            | "CASE"
            | "DAY"
            | "DELETE"
            | "DISK"
            | "ELSE"
            | "END"
            | "FALSE"
            | "GLOBAL"
            | "GROUP"
            | "HOUR"
            | "ILIKE"
            | "IN"
            | "INTERVAL"
            | "IS"
            | "LIKE"
            | "MICROSECOND"
            | "MILLISECOND"
            | "MINUTE"
            | "MONTH"
            | "NANOSECOND"
            | "NOT"
            | "NULL"
            | "OR"
            | "QUARTER"
            | "RECOMPRESS"
            | "SECOND"
            | "SET"
            | "THEN"
            | "TO"
            | "TRUE"
            | "VOLUME"
            | "WEEK"
            | "WHEN"
            | "WHERE"
            | "YEAR"
    )
}

fn collect_top_level_column_words(input: &str) -> IpcResult<Vec<ColumnWordToken>> {
    let bytes = input.as_bytes();
    let mut words = Vec::new();
    let mut quote = None;
    let mut escaped = false;
    let mut closings = Vec::new();
    let mut index = 0;

    while index < bytes.len() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == active_quote {
                if bytes.get(index + 1) == Some(&active_quote) {
                    index += 2;
                } else {
                    quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            active_quote @ (b'\'' | b'"' | b'`') => {
                quote = Some(active_quote);
                index += 1;
            }
            opening @ (b'(' | b'[' | b'{') => {
                closings.push(match opening {
                    b'(' => b')',
                    b'[' => b']',
                    b'{' => b'}',
                    _ => unreachable!("column delimiter is allowlisted"),
                });
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if closings.pop() != Some(closing) {
                    return Err(validation_error(
                        "ClickHouse column definition contains mismatched delimiters",
                    ));
                }
                index += 1;
            }
            byte if closings.is_empty() && (byte.is_ascii_alphabetic() || byte == b'_') => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
                {
                    index += 1;
                }
                let source = &input[start..index];
                if source.bytes().any(|byte| byte.is_ascii_alphabetic())
                    && !source.bytes().any(|byte| byte.is_ascii_lowercase())
                {
                    words.push(ColumnWordToken {
                        start,
                        end: index,
                        uppercase: source.to_string(),
                    });
                }
            }
            _ => index += 1,
        }
    }

    if quote.is_some() {
        return Err(validation_error(
            "ClickHouse column definition contains an unclosed quoted value",
        ));
    }
    if !closings.is_empty() {
        return Err(validation_error(
            "ClickHouse column definition contains unclosed delimiters",
        ));
    }
    Ok(words)
}

fn parse_identifier_prefix(entry: &str) -> IpcResult<(String, &str, bool)> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains an empty body entry",
        ));
    }
    let bytes = entry.as_bytes();
    if matches!(bytes[0], b'`' | b'"') {
        let quote = bytes[0];
        let mut identifier = Vec::new();
        let mut index = 1;
        while index < bytes.len() {
            if bytes[index] == b'\\' {
                let escaped = bytes.get(index + 1).copied().ok_or_else(|| {
                    validation_error(
                        "ClickHouse quoted identifier ends with an incomplete escape sequence",
                    )
                })?;
                identifier.push(escaped);
                index += 2;
                continue;
            }
            if bytes[index] == quote {
                if bytes.get(index + 1) == Some(&quote) {
                    identifier.push(quote);
                    index += 2;
                    continue;
                }
                let identifier = String::from_utf8(identifier).map_err(|error| {
                    validation_error(format!(
                        "ClickHouse quoted identifier is not valid UTF-8: {error}"
                    ))
                })?;
                return Ok((identifier, &entry[index + 1..], true));
            }
            identifier.push(bytes[index]);
            index += 1;
        }
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains an unclosed quoted identifier",
        ));
    }

    let end = bytes
        .iter()
        .position(|byte| byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    Ok((entry[..end].to_string(), &entry[end..], false))
}

fn split_top_level(input: &str, delimiter: u8) -> IpcResult<Vec<String>> {
    if input.trim().is_empty() {
        return Ok(Vec::new());
    }
    let bytes = input.as_bytes();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut closings = Vec::new();

    while index < bytes.len() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == active_quote {
                if bytes.get(index + 1) == Some(&active_quote) {
                    index += 2;
                } else {
                    quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            active_quote @ (b'\'' | b'"' | b'`') => {
                quote = Some(active_quote);
                index += 1;
            }
            b'(' => {
                closings.push(b')');
                index += 1;
            }
            b'[' => {
                closings.push(b']');
                index += 1;
            }
            b'{' => {
                closings.push(b'}');
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if closings.pop() != Some(closing) {
                    return Err(validation_error(
                        "ClickHouse expression contains mismatched delimiters",
                    ));
                }
                index += 1;
            }
            byte if byte == delimiter && closings.is_empty() => {
                let part = input[start..index].trim();
                if part.is_empty() {
                    return Err(validation_error(
                        "ClickHouse expression contains an empty comma-separated item",
                    ));
                }
                parts.push(part.to_string());
                start = index + 1;
                index += 1;
            }
            _ => index += 1,
        }
    }

    if quote.is_some() || !closings.is_empty() {
        return Err(validation_error(
            "ClickHouse expression contains an unclosed quote or delimiter",
        ));
    }
    let last = input[start..].trim();
    if last.is_empty() {
        return Err(validation_error(
            "ClickHouse expression contains a trailing comma",
        ));
    }
    parts.push(last.to_string());
    Ok(parts)
}

fn find_top_level_delimiter(input: &str, delimiter: u8) -> IpcResult<Option<usize>> {
    let bytes = input.as_bytes();
    let mut index = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut closings = Vec::new();

    while index < bytes.len() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == active_quote {
                if bytes.get(index + 1) == Some(&active_quote) {
                    index += 2;
                } else {
                    quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            active_quote @ (b'\'' | b'"' | b'`') => {
                quote = Some(active_quote);
                index += 1;
            }
            b'(' => {
                closings.push(b')');
                index += 1;
            }
            b'[' => {
                closings.push(b']');
                index += 1;
            }
            b'{' => {
                closings.push(b'}');
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if closings.pop() != Some(closing) {
                    return Err(validation_error(
                        "ClickHouse expression contains mismatched delimiters",
                    ));
                }
                index += 1;
            }
            byte if byte == delimiter && closings.is_empty() => return Ok(Some(index)),
            _ => index += 1,
        }
    }

    if quote.is_some() || !closings.is_empty() {
        return Err(validation_error(
            "ClickHouse expression contains an unclosed quote or delimiter",
        ));
    }
    Ok(None)
}

fn validation_error(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const SUPPORTED_CREATE: &str = r#"
        CREATE TABLE analytics.events
        (
            `id` UInt64 CODEC(Delta, ZSTD(1)),
            `ts` DateTime64(3, 'UTC') DEFAULT now64(3),
            `day` Date MATERIALIZED toDate(ts),
            `tenant` LowCardinality(String) COMMENT 'tenant'
        )
        ENGINE = ReplacingMergeTree(ts)
        PARTITION BY toYYYYMM(ts)
        PRIMARY KEY (tenant, id)
        ORDER BY (tenant, id, ts)
        SAMPLE BY id
        TTL ts + INTERVAL 90 DAY DELETE
        SETTINGS index_granularity = 8192, allow_nullable_key = 1
        COMMENT 'events'
    "#;

    #[test]
    fn parser_preserves_supported_mergetree_table_semantics() {
        let parsed = parse_table_clauses(SUPPORTED_CREATE).expect("parse CREATE TABLE");

        assert_eq!(parsed.engine.family, "ReplacingMergeTree");
        assert_eq!(parsed.engine.arguments, vec!["ts"]);
        assert_eq!(parsed.engine.raw_expression, "ReplacingMergeTree(ts)");
        assert_eq!(parsed.keys.partition_by.as_deref(), Some("toYYYYMM(ts)"));
        assert_eq!(parsed.keys.primary_key.as_deref(), Some("(tenant, id)"));
        assert_eq!(parsed.keys.order_by, "(tenant, id, ts)");
        assert_eq!(parsed.keys.sample_by.as_deref(), Some("id"));
        assert_eq!(
            parsed.table_ttl.as_deref(),
            Some("ts + INTERVAL 90 DAY DELETE")
        );
        assert_eq!(parsed.settings.len(), 2);
        assert_eq!(parsed.settings[0].name, "index_granularity");
        assert_eq!(parsed.settings[0].value, "8192");
        assert!(parsed.settings[0].explicit);
        assert_eq!(parsed.settings[1].name, "allow_nullable_key");
        assert_eq!(parsed.comment.as_deref(), Some("events"));
        assert_eq!(parsed.column_names, vec!["id", "ts", "day", "tenant"]);
        assert!(parsed.blockers.is_empty());
    }

    #[test]
    fn parser_extracts_column_ttl_from_canonical_definitions() {
        let sql = r#"CREATE TABLE analytics.events
        (
            `id` UInt64 COMMENT 'TTL hidden' CODEC(Delta, ZSTD(1)),
            `expires_at` DateTime TTL expires_at + INTERVAL 7 DAY,
            `label` String DEFAULT 'TTL hidden'
        )
        ENGINE = MergeTree
        ORDER BY id"#;

        let parsed = parse_table_clauses(sql).expect("parse column TTL facts");

        assert_eq!(parsed.column_ttl_expressions.get("id"), Some(&None));
        assert_eq!(
            parsed
                .column_ttl_expressions
                .get("expires_at")
                .and_then(|value| value.as_deref()),
            Some("expires_at + INTERVAL 7 DAY")
        );
        assert_eq!(parsed.column_ttl_expressions.get("label"), Some(&None));
    }

    #[test]
    fn parser_blocks_unmodeled_column_modifiers_without_truncating_ttl() {
        let sql = r#"CREATE TABLE analytics.events
        (
            `expires_at` DateTime STATISTICS(minmax) TTL expires_at RECOMPRESS CODEC(ZSTD(1)),
            `future_value` UInt64 FUTURE(option) TTL future_value + INTERVAL 1 DAY
        )
        ENGINE = MergeTree
        ORDER BY expires_at"#;

        let parsed = parse_table_clauses(sql).expect("parse unsupported column modifiers");

        assert_eq!(
            parsed
                .column_ttl_expressions
                .get("expires_at")
                .and_then(|value| value.as_deref()),
            Some("expires_at RECOMPRESS CODEC(ZSTD(1))")
        );
        for column in ["expires_at", "future_value"] {
            assert!(parsed
                .column_blockers
                .get(column)
                .is_some_and(|blockers| blockers
                    .iter()
                    .any(|blocker| blocker.code == "unsupported_column_clause")));
        }
    }

    #[test]
    fn parser_keeps_top_level_function_calls_out_of_modifier_blockers() {
        let sql = r#"CREATE TABLE analytics.events
        (
            `value` UInt64 DEFAULT CAST(1 AS UInt64),
            `expires_at` DateTime TTL CAST(expires_at AS DateTime) + INTERVAL 7 DAY
        )
        ENGINE = MergeTree
        ORDER BY value"#;

        let parsed = parse_table_clauses(sql).expect("parse top-level function calls");

        assert!(parsed.column_blockers.is_empty());
        assert_eq!(
            parsed
                .column_ttl_expressions
                .get("expires_at")
                .and_then(|value| value.as_deref()),
            Some("CAST(expires_at AS DateTime) + INTERVAL 7 DAY")
        );
    }

    #[test]
    fn parser_splits_only_top_level_engine_arguments_and_settings() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = ReplacingMergeTree(tuple('a,b', id), version)
            ORDER BY id
            SETTINGS custom = tuple('x,y', 2), index_granularity = 8192
        "#;

        let parsed = parse_table_clauses(sql).expect("parse nested expressions");

        assert_eq!(parsed.engine.arguments, vec!["tuple('a,b', id)", "version"]);
        assert_eq!(parsed.settings[0].value, "tuple('x,y', 2)");
        assert_eq!(parsed.settings[1].name, "index_granularity");
    }

    #[test]
    fn parser_turns_unknown_trailing_semantics_into_a_blocker() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = MergeTree()
            ORDER BY id
            AS SELECT id FROM analytics.source
        "#;

        let parsed = parse_table_clauses(sql).expect("unknown clause remains describable");

        assert_eq!(parsed.blockers.len(), 1);
        assert_eq!(parsed.blockers[0].code, "unsupported_create_clause");
        assert!(parsed.blockers[0].message.contains("AS SELECT id"));
    }

    #[test]
    fn parser_keeps_unknown_engines_describable_without_order_by() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = TinyLog
            COMMENT 'it\'s readonly'
        "#;

        let parsed = parse_table_clauses(sql).expect("unknown engine remains describable");

        assert_eq!(parsed.engine.family, "TinyLog");
        assert!(parsed.engine.arguments.is_empty());
        assert!(parsed.keys.order_by.is_empty());
        assert_eq!(parsed.comment.as_deref(), Some("it's readonly"));
    }

    #[test]
    fn parser_preserves_quoted_keyword_and_escaped_column_names() {
        let sql = r#"
            CREATE TABLE analytics.events
            (
                `INDEX` UInt64,
                `CONSTRAINT` String,
                `PRIMARY` String,
                `PROJECTION` UInt8,
                `a\`b` UInt64,
                `用户` String
            )
            ENGINE = MergeTree()
            ORDER BY tuple()
        "#;

        let parsed = parse_table_clauses(sql).expect("parse quoted column names");

        assert_eq!(
            parsed.column_names,
            vec![
                "INDEX",
                "CONSTRAINT",
                "PRIMARY",
                "PROJECTION",
                "a`b",
                "用户"
            ]
        );
        assert!(parsed.blockers.is_empty());
    }

    #[test]
    fn parser_decodes_supported_comment_escapes_and_rejects_unknown_ones() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = MergeTree()
            ORDER BY id
            COMMENT 'line\nnext\tvalue'
        "#;

        let parsed = parse_table_clauses(sql).expect("parse escaped comment");
        assert_eq!(parsed.comment.as_deref(), Some("line\nnext\tvalue"));

        let unsupported = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = MergeTree()
            ORDER BY id
            COMMENT 'unknown\qescape'
        "#;
        let error = parse_table_clauses(unsupported).expect_err("unknown escape must fail closed");
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn parser_rejects_malformed_engine_settings_and_sql() {
        for sql in [
            "CREATE TABLE t (`id` UInt64) ENGINE = MergeTree( ORDER BY id",
            "CREATE TABLE t (`id` UInt64)\nENGINE = MergeTree()\nORDER BY id\nSETTINGS broken",
            "CREATE TABLE t (`id` UInt64) ENGINE = MergeTree() ORDER BY id; SELECT 1",
        ] {
            let error = parse_table_clauses(sql).expect_err("malformed input must fail");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }
}
