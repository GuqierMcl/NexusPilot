#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use crate::error::{IpcError, IpcResult};

use super::ClickHouseViewParameter;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClickHouseViewQueryFacts {
    pub parameters: Vec<ClickHouseViewParameter>,
    pub top_level_function_calls: BTreeSet<String>,
    pub has_top_level_group_by: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TopLevelWord {
    normalized: String,
    end: usize,
}

pub fn scan_view_query(query: &str) -> IpcResult<ClickHouseViewQueryFacts> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(validation_error("ClickHouse View query is required"));
    }

    let (words, functions) = scan_top_level_query(trimmed)?;
    let first = words.first().map(|word| word.normalized.as_str());
    let has_select = words.iter().any(|word| word.normalized == "select");
    if !matches!(first, Some("select" | "with")) || !has_select {
        return Err(validation_error(
            "ClickHouse View query must be one SELECT or WITH SELECT",
        ));
    }

    let forbidden_statement_tail = words.windows(2).any(|pair| {
        matches!(
            (pair[0].normalized.as_str(), pair[1].normalized.as_str()),
            ("insert", "into")
                | ("delete", "from")
                | ("create", "table" | "view" | "database")
                | ("alter", "table" | "view" | "database")
                | ("drop", "table" | "view" | "database")
                | ("truncate", "table")
                | ("rename", "table")
                | ("into", "outfile")
        )
    });
    if words.iter().any(|word| word.normalized == "format") || forbidden_statement_tail {
        return Err(validation_error(
            "ClickHouse View query contains a forbidden top-level clause",
        ));
    }
    if words
        .windows(2)
        .any(|pair| pair[0].normalized == "into" && pair[1].normalized == "outfile")
    {
        return Err(validation_error(
            "ClickHouse View query cannot write to an output file",
        ));
    }

    let has_top_level_group_by = words
        .windows(2)
        .any(|pair| pair[0].normalized == "group" && pair[1].normalized == "by");

    Ok(ClickHouseViewQueryFacts {
        parameters: extract_parameters(trimmed)?,
        top_level_function_calls: functions,
        has_top_level_group_by,
    })
}

pub(crate) fn view_queries_semantically_equal(left: &str, right: &str) -> bool {
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Token {
        Word(String),
        StringLiteral(String),
        Symbol(char),
    }

    fn tokenize(value: &str) -> Vec<Token> {
        let characters = value.chars().collect::<Vec<_>>();
        let mut tokens = Vec::new();
        let mut index = 0usize;
        while index < characters.len() {
            let character = characters[index];
            if character.is_whitespace() {
                index += 1;
                continue;
            }
            if character == '\'' {
                let start = index;
                index += 1;
                let mut escaped = false;
                while index < characters.len() {
                    let current = characters[index];
                    index += 1;
                    if escaped {
                        escaped = false;
                    } else if current == '\\' {
                        escaped = true;
                    } else if current == '\'' {
                        break;
                    }
                }
                tokens.push(Token::StringLiteral(
                    characters[start..index].iter().collect(),
                ));
                continue;
            }
            if character == '`' {
                let start = index + 1;
                index = start;
                while index < characters.len() && characters[index] != '`' {
                    index += 1;
                }
                let identifier = characters[start..index].iter().collect::<String>();
                let simple = identifier
                    .chars()
                    .next()
                    .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
                    && identifier
                        .chars()
                        .all(|value| value.is_ascii_alphanumeric() || value == '_');
                if simple {
                    tokens.push(Token::Word(identifier));
                } else {
                    tokens.push(Token::StringLiteral(format!("`{identifier}`")));
                }
                index = index.saturating_add(1);
                continue;
            }
            if character.is_ascii_alphanumeric() || character == '_' {
                let start = index;
                index += 1;
                while index < characters.len()
                    && (characters[index].is_ascii_alphanumeric() || characters[index] == '_')
                {
                    index += 1;
                }
                tokens.push(Token::Word(characters[start..index].iter().collect()));
                continue;
            }
            tokens.push(Token::Symbol(character));
            index += 1;
        }
        tokens
    }

    fn strip_self_aliases(tokens: Vec<Token>) -> Vec<Token> {
        let mut normalized = Vec::with_capacity(tokens.len());
        let mut index = 0usize;
        while index < tokens.len() {
            let is_as =
                matches!(&tokens[index], Token::Word(word) if word.eq_ignore_ascii_case("as"));
            if is_as {
                if let (Some(Token::Word(previous)), Some(Token::Word(alias))) =
                    (normalized.last(), tokens.get(index + 1))
                {
                    if previous == alias {
                        index += 2;
                        continue;
                    }
                }
            }
            normalized.push(tokens[index].to_owned());
            index += 1;
        }
        normalized
    }

    strip_self_aliases(tokenize(left)) == strip_self_aliases(tokenize(right))
}

pub fn extract_parameters(query: &str) -> IpcResult<Vec<ClickHouseViewParameter>> {
    let bytes = query.as_bytes();
    let mut parameters = BTreeMap::<String, (String, u32, usize)>::new();
    let mut order = 0usize;
    let mut index = 0usize;

    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                index = skip_quoted(bytes, index, bytes[index])?;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2)?;
            }
            b'{' => {
                if let Some((end, name, type_name)) = parse_parameter(bytes, index)? {
                    match parameters.get_mut(&name) {
                        Some((known_type, occurrences, _)) if known_type == &type_name => {
                            *occurrences += 1;
                        }
                        Some(_) => {
                            return Err(validation_error(
                                "ClickHouse View parameter uses conflicting types",
                            ));
                        }
                        None => {
                            parameters.insert(name, (type_name, 1, order));
                            order += 1;
                        }
                    }
                    index = end;
                } else {
                    index += 1;
                }
            }
            _ => index += 1,
        }
    }

    let mut values = parameters
        .into_iter()
        .map(|(name, (type_name, occurrences, order))| {
            (
                order,
                ClickHouseViewParameter {
                    name,
                    type_name,
                    occurrences,
                },
            )
        })
        .collect::<Vec<_>>();
    values.sort_by_key(|(order, _)| *order);
    Ok(values.into_iter().map(|(_, parameter)| parameter).collect())
}

pub fn contains_top_level_time_window(
    query: &str,
    supported_functions: &BTreeSet<String>,
) -> IpcResult<bool> {
    let facts = scan_view_query(query)?;
    Ok(facts
        .top_level_function_calls
        .iter()
        .any(|function| supported_functions.contains(function)))
}

fn scan_top_level_query(query: &str) -> IpcResult<(Vec<TopLevelWord>, BTreeSet<String>)> {
    let bytes = query.as_bytes();
    let mut words = Vec::new();
    let mut functions = BTreeSet::new();
    let mut delimiters = Vec::<u8>::new();
    let mut index = 0usize;
    let mut terminated = false;

    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'\'' | b'"' | b'`' => {
                index = skip_quoted(bytes, index, byte)?;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index = skip_line_comment(bytes, index + 2);
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_block_comment(bytes, index + 2)?;
            }
            b'(' | b'[' => {
                delimiters.push(byte);
                index += 1;
            }
            b')' | b']' => {
                let expected = if byte == b')' { b'(' } else { b'[' };
                if delimiters.pop() != Some(expected) {
                    return Err(validation_error(
                        "ClickHouse View query has unbalanced delimiters",
                    ));
                }
                index += 1;
            }
            b';' if delimiters.is_empty() => {
                if terminated || has_non_comment_content(bytes, index + 1)? {
                    return Err(validation_error(
                        "ClickHouse View query must contain exactly one statement",
                    ));
                }
                terminated = true;
                index += 1;
            }
            _ if is_word_start(byte) => {
                let start = index;
                index += 1;
                while index < bytes.len() && is_word_continue(bytes[index]) {
                    index += 1;
                }
                if delimiters.is_empty() && !terminated {
                    let normalized = query[start..index].to_ascii_lowercase();
                    let next = skip_ascii_space(bytes, index);
                    if bytes.get(next) == Some(&b'(') {
                        functions.insert(normalized.clone());
                    }
                    words.push(TopLevelWord {
                        normalized,
                        end: index,
                    });
                }
            }
            _ => index += 1,
        }
    }

    if !delimiters.is_empty() {
        return Err(validation_error(
            "ClickHouse View query has unbalanced delimiters",
        ));
    }
    Ok((words, functions))
}

fn parse_parameter(bytes: &[u8], start: usize) -> IpcResult<Option<(usize, String, String)>> {
    let mut index = start + 1;
    if bytes.get(index).is_none_or(|byte| !is_word_start(*byte)) {
        return Ok(None);
    }
    let name_start = index;
    index += 1;
    while bytes.get(index).is_some_and(|byte| is_word_continue(*byte)) {
        index += 1;
    }
    if bytes.get(index) != Some(&b':') {
        return Ok(None);
    }
    let name = String::from_utf8_lossy(&bytes[name_start..index]).to_string();
    index += 1;
    let type_start = index;
    let mut parentheses = 0u32;
    while index < bytes.len() {
        match bytes[index] {
            b'(' => parentheses += 1,
            b')' => {
                if parentheses == 0 {
                    return Err(validation_error(
                        "ClickHouse View parameter type is malformed",
                    ));
                }
                parentheses -= 1;
            }
            b'}' if parentheses == 0 => {
                let type_name = String::from_utf8_lossy(&bytes[type_start..index])
                    .trim()
                    .to_string();
                if type_name.is_empty()
                    || !type_name.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric()
                            || matches!(byte, b'_' | b'(' | b')' | b',' | b' ' | b'\'' | b'"')
                    })
                {
                    return Err(validation_error(
                        "ClickHouse View parameter type is malformed",
                    ));
                }
                return Ok(Some((index + 1, name, type_name)));
            }
            b'{' | b';' | b'\n' | b'\r' => {
                return Err(validation_error(
                    "ClickHouse View parameter placeholder is malformed",
                ));
            }
            _ => {}
        }
        index += 1;
    }
    Err(validation_error(
        "ClickHouse View parameter placeholder is unclosed",
    ))
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
        "ClickHouse View query contains an unclosed quoted token",
    ))
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
        "ClickHouse View query contains an unclosed block comment",
    ))
}

fn has_non_comment_content(bytes: &[u8], mut index: usize) -> IpcResult<bool> {
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
        } else if bytes[index] == b'-' && bytes.get(index + 1) == Some(&b'-') {
            index = skip_line_comment(bytes, index + 2);
        } else if bytes[index] == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index = skip_block_comment(bytes, index + 2)?;
        } else {
            return Ok(true);
        }
    }
    Ok(false)
}

fn skip_ascii_space(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        index += 1;
    }
    index
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
    use std::collections::BTreeSet;

    use super::*;
    use crate::engine::drivers::clickhouse::schema::ClickHouseViewParameter;

    #[test]
    fn semantic_query_compare_ignores_server_generated_self_aliases() {
        assert!(view_queries_semantically_equal(
            "SELECT id AS id, value AS value FROM analytics.source WHERE tenant > 0",
            "SELECT id, value FROM analytics.source WHERE tenant > 0",
        ));
        assert!(!view_queries_semantically_equal(
            "SELECT source.id AS renamed FROM analytics.source",
            "SELECT id FROM analytics.source",
        ));
    }

    #[test]
    fn scanner_accepts_one_select_and_extracts_stable_parameter_facts() {
        let facts = scan_view_query(
            "WITH 1 AS one SELECT {tenant:UInt64}, {tenant:UInt64}, tumble(ts) \
             FROM events WHERE note = '{ignored:String}' GROUP BY tenant",
        )
        .unwrap();
        assert_eq!(
            facts.parameters,
            vec![ClickHouseViewParameter {
                name: "tenant".to_string(),
                type_name: "UInt64".to_string(),
                occurrences: 2,
            }]
        );
        assert!(facts.top_level_function_calls.contains("tumble"));
        assert!(facts.has_top_level_group_by);
        assert!(contains_top_level_time_window(
            "SELECT tumble(ts) FROM events",
            &BTreeSet::from(["tumble".to_string()]),
        )
        .unwrap());
        assert!(scan_view_query("SELECT name FROM system.tables").is_ok());
    }

    #[test]
    fn scanner_rejects_multi_statement_output_and_mutation_boundaries() {
        for query in [
            "SELECT 1; DROP TABLE events",
            "SELECT 1 FORMAT JSON",
            "SELECT 1 INTO OUTFILE 'dump'",
            "INSERT INTO sink SELECT 1",
            "SELECT 1 /* unclosed",
            "SELECT (1",
        ] {
            assert!(scan_view_query(query).is_err(), "query={query}");
        }
    }

    #[test]
    fn parameter_scanner_ignores_quotes_comments_and_rejects_conflicting_types() {
        let parameters = extract_parameters(
            "SELECT '{ignored:String}', `x{ignored:UInt64}`, {real:Array(UInt64)} \
             /* {ignored:Date} */ -- {ignored:UUID}\nFROM events",
        )
        .unwrap();
        assert_eq!(parameters.len(), 1);
        assert_eq!(parameters[0].name, "real");
        assert_eq!(parameters[0].type_name, "Array(UInt64)");
        assert!(extract_parameters("SELECT {x:UInt64}, {x:String}").is_err());
    }
}
