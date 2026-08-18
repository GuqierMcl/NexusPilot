use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct UnknownTableClause {
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ScannedTableClauses {
    pub table_body: String,
    pub engine: String,
    pub partition_by: Option<String>,
    pub primary_key: Option<String>,
    pub order_by: String,
    pub sample_by: Option<String>,
    pub table_ttl: Option<String>,
    pub settings: Option<String>,
    pub comment: Option<String>,
    pub unknown_clauses: Vec<UnknownTableClause>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClauseKind {
    Engine,
    PartitionBy,
    PrimaryKey,
    OrderBy,
    SampleBy,
    Ttl,
    Settings,
    Comment,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
struct ClauseMarker {
    kind: ClauseKind,
    start: usize,
    value_start: usize,
}

#[derive(Debug)]
struct WordToken {
    start: usize,
    end: usize,
    uppercase: String,
    logical_line_start: bool,
}

#[derive(Debug, Default)]
struct ScanState {
    delimiter_stack: Vec<u8>,
    quote: Option<u8>,
    escaped: bool,
    line_comment: bool,
    block_comment: bool,
}

#[allow(dead_code)]
pub(super) fn validate_single_expression(input: &str, path: &str) -> IpcResult<()> {
    if input.trim().is_empty() {
        return Err(IpcError::validation_failed(format!(
            "ClickHouse {path} requires a non-empty expression"
        )));
    }
    scan_expression_boundary(input)
        .map_err(|reason| IpcError::validation_failed(format!("ClickHouse {path} {reason}")))
}

#[allow(dead_code)]
pub(super) fn expression_references_identifier(input: &str, identifier: &str) -> bool {
    if identifier.is_empty() {
        return false;
    }

    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'#' => {
                index += 1;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index += 2;
                while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                index = (index + 2).min(bytes.len());
            }
            b'\'' => index = skip_quoted_token(bytes, index, b'\''),
            quote @ (b'"' | b'`') => {
                let (next_index, decoded) = read_quoted_identifier(bytes, index, quote);
                if decoded.as_deref() == Some(identifier) {
                    return true;
                }
                index = next_index;
            }
            byte if is_identifier_start(byte) => {
                let start = index;
                index += 1;
                while index < bytes.len() && is_identifier_continue(bytes[index]) {
                    index += 1;
                }
                if &input[start..index] == identifier {
                    return true;
                }
            }
            _ => index += 1,
        }
    }
    false
}

fn skip_quoted_token(bytes: &[u8], start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    let mut escaped = false;
    while index < bytes.len() {
        if escaped {
            escaped = false;
            index += 1;
        } else if bytes[index] == b'\\' {
            escaped = true;
            index += 1;
        } else if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                index += 2;
            } else {
                return index + 1;
            }
        } else {
            index += 1;
        }
    }
    bytes.len()
}

fn read_quoted_identifier(bytes: &[u8], start: usize, quote: u8) -> (usize, Option<String>) {
    let mut decoded = Vec::new();
    let mut index = start + 1;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            if let Some(next) = bytes.get(index + 1) {
                decoded.push(*next);
                index += 2;
            } else {
                return (bytes.len(), None);
            }
        } else if bytes[index] == quote {
            if bytes.get(index + 1) == Some(&quote) {
                decoded.push(quote);
                index += 2;
            } else {
                return (index + 1, String::from_utf8(decoded).ok());
            }
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    (bytes.len(), None)
}

fn is_identifier_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic() || byte >= 0x80
}

fn is_identifier_continue(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit()
}

#[allow(dead_code)]
fn scan_expression_boundary(input: &str) -> Result<(), &'static str> {
    let bytes = input.as_bytes();
    let mut delimiter_stack = Vec::new();
    let mut quote = None;
    let mut escaped = false;
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
            quote_byte @ (b'\'' | b'"' | b'`') => {
                quote = Some(quote_byte);
                index += 1;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                return Err("must not contain SQL comments");
            }
            b'#' => return Err("must not contain SQL comments"),
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                return Err("must not contain SQL comments");
            }
            opening @ (b'(' | b'[' | b'{') => {
                delimiter_stack.push(matching_delimiter(opening));
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if delimiter_stack.pop() != Some(closing) {
                    return Err("contains mismatched delimiters");
                }
                index += 1;
            }
            b';' if delimiter_stack.is_empty() => {
                return Err("must contain exactly one expression");
            }
            _ => index += 1,
        }
    }

    if quote.is_some() {
        return Err("contains an unclosed quoted value");
    }
    if !delimiter_stack.is_empty() {
        return Err("contains unclosed delimiters");
    }
    Ok(())
}

pub(super) fn scan_table_clauses(sql: &str) -> IpcResult<ScannedTableClauses> {
    let (body_start, body_end) = locate_table_body(sql)?;
    let table_body = strip_sql_comments(&sql[body_start + 1..body_end])
        .trim()
        .to_string();
    let tail_start = body_end + 1;
    let (words, statement_end) = collect_top_level_words(sql, tail_start)?;
    let markers = clause_markers(sql, &words, tail_start);
    let mut unknown_clauses = Vec::new();

    if let Some(first) = markers.first() {
        let prefix = cleaned_segment(sql, tail_start, first.start);
        if !prefix.is_empty() {
            unknown_clauses.push(UnknownTableClause { raw: prefix });
        }
    } else {
        let trailing = cleaned_segment(sql, tail_start, statement_end);
        if !trailing.is_empty() {
            unknown_clauses.push(UnknownTableClause { raw: trailing });
        }
    }

    let mut engine = None;
    let mut partition_by = None;
    let mut primary_key = None;
    let mut order_by = None;
    let mut sample_by = None;
    let mut table_ttl = None;
    let mut settings = None;
    let mut comment = None;

    for (index, marker) in markers.iter().enumerate() {
        let end = markers
            .get(index + 1)
            .map_or(statement_end, |next| next.start);
        let mut value = cleaned_segment(sql, marker.value_start, end);

        if marker.kind == ClauseKind::Engine {
            value = value
                .strip_prefix('=')
                .map_or(value.clone(), |rest| rest.trim().to_string());
        }

        if marker.kind == ClauseKind::Unknown {
            let raw = cleaned_segment(sql, marker.start, end);
            if !raw.is_empty() {
                unknown_clauses.push(UnknownTableClause { raw });
            }
            continue;
        }

        if value.is_empty() {
            return Err(validation_error(format!(
                "ClickHouse CREATE TABLE clause {:?} has no value",
                marker.kind
            )));
        }

        match marker.kind {
            ClauseKind::Engine => assign_once(&mut engine, value, "ENGINE")?,
            ClauseKind::PartitionBy => assign_once(&mut partition_by, value, "PARTITION BY")?,
            ClauseKind::PrimaryKey => assign_once(&mut primary_key, value, "PRIMARY KEY")?,
            ClauseKind::OrderBy => assign_once(&mut order_by, value, "ORDER BY")?,
            ClauseKind::SampleBy => assign_once(&mut sample_by, value, "SAMPLE BY")?,
            ClauseKind::Ttl => assign_once(&mut table_ttl, value, "TTL")?,
            ClauseKind::Settings => assign_once(&mut settings, value, "SETTINGS")?,
            ClauseKind::Comment => assign_once(&mut comment, value, "COMMENT")?,
            ClauseKind::Unknown => unreachable!("unknown clause handled above"),
        }
    }

    Ok(ScannedTableClauses {
        table_body,
        engine: engine.ok_or_else(|| {
            validation_error("ClickHouse CREATE TABLE is missing the ENGINE clause")
        })?,
        partition_by,
        primary_key,
        order_by: order_by.unwrap_or_default(),
        sample_by,
        table_ttl,
        settings,
        comment,
        unknown_clauses,
    })
}

fn assign_once(target: &mut Option<String>, value: String, clause: &str) -> IpcResult<()> {
    if target.replace(value).is_some() {
        return Err(validation_error(format!(
            "ClickHouse CREATE TABLE contains duplicate {clause} clauses"
        )));
    }
    Ok(())
}

fn locate_table_body(sql: &str) -> IpcResult<(usize, usize)> {
    let bytes = sql.as_bytes();
    let mut state = ScanState::default();
    let mut body_start = None;
    let mut body_end = None;
    let mut index = 0;

    while index < bytes.len() {
        if state.line_comment {
            if bytes[index] == b'\n' {
                state.line_comment = false;
            }
            index += 1;
            continue;
        }
        if state.block_comment {
            if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                state.block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(quote) = state.quote {
            if state.escaped {
                state.escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                state.escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == quote {
                if bytes.get(index + 1) == Some(&quote) {
                    index += 2;
                } else {
                    state.quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                state.line_comment = true;
                index += 2;
            }
            b'#' => {
                state.line_comment = true;
                index += 1;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                state.block_comment = true;
                index += 2;
            }
            quote @ (b'\'' | b'"' | b'`') => {
                state.quote = Some(quote);
                index += 1;
            }
            opening @ (b'(' | b'[' | b'{') => {
                if opening == b'(' && state.delimiter_stack.is_empty() && body_start.is_none() {
                    body_start = Some(index);
                }
                state.delimiter_stack.push(matching_delimiter(opening));
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if state.delimiter_stack.pop() != Some(closing) {
                    return Err(validation_error(
                        "ClickHouse CREATE TABLE contains mismatched delimiters",
                    ));
                }
                if state.delimiter_stack.is_empty()
                    && closing == b')'
                    && body_start.is_some()
                    && body_end.is_none()
                {
                    body_end = Some(index);
                }
                index += 1;
            }
            b';' if state.delimiter_stack.is_empty() && body_end.is_none() => {
                return Err(validation_error(
                    "ClickHouse CREATE TABLE header contains multiple statements",
                ));
            }
            _ => index += 1,
        }
    }

    if state.quote.is_some() {
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains an unclosed quoted value",
        ));
    }
    if state.block_comment {
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains an unclosed block comment",
        ));
    }
    if !state.delimiter_stack.is_empty() {
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains unclosed delimiters",
        ));
    }

    match (body_start, body_end) {
        (Some(start), Some(end)) => {
            validate_create_table_header(sql, start)?;
            Ok((start, end))
        }
        _ => Err(validation_error(
            "ClickHouse CREATE TABLE is missing a balanced column body",
        )),
    }
}

fn validate_create_table_header(sql: &str, body_start: usize) -> IpcResult<()> {
    let header = strip_sql_comments(&sql[..body_start]);
    let mut words = header.split_whitespace();
    let is_create_table = words
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case("CREATE"))
        && words
            .next()
            .is_some_and(|word| word.eq_ignore_ascii_case("TABLE"));
    if !is_create_table {
        return Err(validation_error(
            "ClickHouse schema parser accepts only CREATE TABLE statements",
        ));
    }
    Ok(())
}

fn collect_top_level_words(sql: &str, start: usize) -> IpcResult<(Vec<WordToken>, usize)> {
    let bytes = sql.as_bytes();
    let mut state = ScanState::default();
    let mut words = Vec::new();
    let mut index = start;
    let mut statement_end = bytes.len();
    let mut line_has_code = false;

    while index < bytes.len() {
        if state.line_comment {
            if bytes[index] == b'\n' {
                state.line_comment = false;
                line_has_code = false;
            }
            index += 1;
            continue;
        }
        if state.block_comment {
            if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                state.block_comment = false;
                index += 2;
            } else {
                if bytes[index] == b'\n' {
                    line_has_code = false;
                }
                index += 1;
            }
            continue;
        }
        if let Some(quote) = state.quote {
            if bytes[index] == b'\n' {
                line_has_code = true;
            }
            if state.escaped {
                state.escaped = false;
                index += 1;
                continue;
            }
            if bytes[index] == b'\\' {
                state.escaped = true;
                index += 1;
                continue;
            }
            if bytes[index] == quote {
                if bytes.get(index + 1) == Some(&quote) {
                    index += 2;
                } else {
                    state.quote = None;
                    index += 1;
                }
                continue;
            }
            index += 1;
            continue;
        }

        match bytes[index] {
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                state.line_comment = true;
                index += 2;
            }
            b'#' => {
                state.line_comment = true;
                index += 1;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                state.block_comment = true;
                index += 2;
            }
            quote @ (b'\'' | b'"' | b'`') => {
                state.quote = Some(quote);
                line_has_code = true;
                index += 1;
            }
            opening @ (b'(' | b'[' | b'{') => {
                state.delimiter_stack.push(matching_delimiter(opening));
                line_has_code = true;
                index += 1;
            }
            closing @ (b')' | b']' | b'}') => {
                if state.delimiter_stack.pop() != Some(closing) {
                    return Err(validation_error(
                        "ClickHouse CREATE TABLE contains mismatched delimiters",
                    ));
                }
                line_has_code = true;
                index += 1;
            }
            b';' if state.delimiter_stack.is_empty() => {
                statement_end = index;
                let remainder = strip_sql_comments(&sql[index + 1..]);
                if !remainder.trim().is_empty() {
                    return Err(validation_error(
                        "ClickHouse CREATE TABLE must contain exactly one statement",
                    ));
                }
                break;
            }
            byte if state.delimiter_stack.is_empty() && is_word_start(byte) => {
                let word_start = index;
                index += 1;
                while index < bytes.len() && is_word_continue(bytes[index]) {
                    index += 1;
                }
                words.push(WordToken {
                    start: word_start,
                    end: index,
                    uppercase: sql[word_start..index].to_ascii_uppercase(),
                    logical_line_start: !line_has_code,
                });
                line_has_code = true;
            }
            b'\n' => {
                line_has_code = false;
                index += 1;
            }
            byte if byte.is_ascii_whitespace() => index += 1,
            _ => {
                line_has_code = true;
                index += 1;
            }
        }
    }

    if !state.delimiter_stack.is_empty() {
        return Err(validation_error(
            "ClickHouse CREATE TABLE contains unclosed delimiters",
        ));
    }

    Ok((words, statement_end))
}

fn clause_markers(sql: &str, words: &[WordToken], tail_start: usize) -> Vec<ClauseMarker> {
    // ClickHouse's canonical CREATE output uses uppercase clause heads on logical lines.
    // Lowercase keyword-like words on continuation lines remain expression identifiers;
    // uppercase inline clause-like words are retained as unknown instead of being guessed.
    let mut markers: Vec<ClauseMarker> = Vec::new();
    let mut index = 0;

    while index < words.len() {
        let current = &words[index];
        let next = words.get(index + 1);
        let known_marker = known_clause_marker(current, next);
        let expression_call = markers.last().is_some_and(|active| {
            word_starts_expression_call(sql, current)
                && expression_can_continue_with_call(&cleaned_segment(
                    sql,
                    active.value_start,
                    current.start,
                ))
        });
        let inline_known_marker = known_marker.is_some() && !expression_call;
        let is_boundary = if markers.is_empty() {
            cleaned_segment(sql, tail_start, current.start).is_empty()
        } else {
            current.logical_line_start || inline_known_marker
        };
        if !is_boundary {
            let looks_like_unknown_inline_clause = markers.last().is_some_and(|active| {
                !cleaned_segment(sql, active.value_start, current.start).is_empty()
                    && !expression_call
                    && !allows_inline_expression_word(active.kind, &current.uppercase)
            });
            if source_word_is_uppercase(sql, current)
                && (inline_known_marker
                    || current.uppercase.contains('_')
                    || looks_like_unknown_inline_clause)
            {
                markers.push(ClauseMarker {
                    kind: ClauseKind::Unknown,
                    start: current.start,
                    value_start: current.end,
                });
                break;
            }
            index += 1;
            continue;
        }
        if !source_word_is_uppercase(sql, current) {
            index += 1;
            continue;
        }
        let (kind, consumed) = known_marker.unwrap_or((ClauseKind::Unknown, 1));

        let value_start = words[index + consumed - 1].end;
        markers.push(ClauseMarker {
            kind,
            start: current.start,
            value_start,
        });
        index += consumed;

        if kind == ClauseKind::Unknown {
            break;
        }
    }

    markers
}

fn word_starts_expression_call(sql: &str, word: &WordToken) -> bool {
    sql.as_bytes()
        .get(word.end)
        .is_some_and(|byte| matches!(*byte, b'(' | b'['))
}

fn expression_can_continue_with_call(prefix: &str) -> bool {
    let prefix = prefix.trim_end();
    if prefix.is_empty() {
        return true;
    }
    if prefix.as_bytes().last().is_some_and(|byte| {
        matches!(
            *byte,
            b'+' | b'-'
                | b'*'
                | b'/'
                | b'%'
                | b'^'
                | b'='
                | b'<'
                | b'>'
                | b'!'
                | b'&'
                | b'|'
                | b','
                | b'('
                | b'['
                | b'{'
                | b'?'
                | b':'
        )
    }) {
        return true;
    }
    let last_word = prefix
        .split(|character: char| !character.is_ascii_alphanumeric() && character != '_')
        .next_back()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        last_word.as_str(),
        "AND"
            | "AS"
            | "BETWEEN"
            | "BY"
            | "CASE"
            | "ELSE"
            | "GLOBAL"
            | "ILIKE"
            | "IN"
            | "IS"
            | "LIKE"
            | "NOT"
            | "OR"
            | "THEN"
            | "TO"
            | "WHEN"
    )
}

fn allows_inline_expression_word(kind: ClauseKind, word: &str) -> bool {
    const COMMON_EXPRESSION_WORDS: &[&str] = &[
        "AND",
        "AS",
        "ASC",
        "BETWEEN",
        "CASE",
        "COLLATE",
        "DAY",
        "DESC",
        "ELSE",
        "END",
        "FALSE",
        "FIRST",
        "FROM",
        "GLOBAL",
        "HOUR",
        "ILIKE",
        "IN",
        "INTERPOLATE",
        "INTERVAL",
        "IS",
        "LAST",
        "LIKE",
        "MICROSECOND",
        "MILLISECOND",
        "MINUTE",
        "MONTH",
        "NANOSECOND",
        "NOT",
        "NULL",
        "NULLS",
        "OR",
        "QUARTER",
        "SECOND",
        "STALENESS",
        "STEP",
        "THEN",
        "TO",
        "TRUE",
        "WEEK",
        "WHEN",
        "WITH",
        "YEAR",
    ];
    if COMMON_EXPRESSION_WORDS.contains(&word) {
        return true;
    }
    match kind {
        ClauseKind::Ttl => matches!(
            word,
            "BY" | "CODEC"
                | "DELETE"
                | "DISK"
                | "GROUP"
                | "RECOMPRESS"
                | "SET"
                | "VOLUME"
                | "WHERE"
        ),
        ClauseKind::Settings => matches!(word, "DEFAULT"),
        _ => false,
    }
}

fn known_clause_marker(
    current: &WordToken,
    next: Option<&WordToken>,
) -> Option<(ClauseKind, usize)> {
    match current.uppercase.as_str() {
        "ENGINE" => Some((ClauseKind::Engine, 1)),
        "PARTITION" if next.is_some_and(|word| word.uppercase == "BY") => {
            Some((ClauseKind::PartitionBy, 2))
        }
        "PRIMARY" if next.is_some_and(|word| word.uppercase == "KEY") => {
            Some((ClauseKind::PrimaryKey, 2))
        }
        "ORDER" if next.is_some_and(|word| word.uppercase == "BY") => {
            Some((ClauseKind::OrderBy, 2))
        }
        "SAMPLE" if next.is_some_and(|word| word.uppercase == "BY") => {
            Some((ClauseKind::SampleBy, 2))
        }
        "TTL" => Some((ClauseKind::Ttl, 1)),
        "SETTINGS" => Some((ClauseKind::Settings, 1)),
        "COMMENT" => Some((ClauseKind::Comment, 1)),
        "EMPTY" | "CLONE" if next.is_some_and(|word| word.uppercase == "AS") => {
            Some((ClauseKind::Unknown, 2))
        }
        "AS" => Some((ClauseKind::Unknown, 1)),
        _ => None,
    }
}

fn source_word_is_uppercase(sql: &str, word: &WordToken) -> bool {
    let source = &sql[word.start..word.end];
    source.bytes().any(|byte| byte.is_ascii_alphabetic())
        && !source.bytes().any(|byte| byte.is_ascii_lowercase())
}

fn cleaned_segment(sql: &str, start: usize, end: usize) -> String {
    strip_sql_comments(&sql[start..end])
        .trim()
        .trim_end_matches(';')
        .trim()
        .to_string()
}

fn strip_sql_comments(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;

    while index < bytes.len() {
        if let Some(active_quote) = quote {
            output.push(bytes[index]);
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
                    output.push(active_quote);
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
            quote_byte @ (b'\'' | b'"' | b'`') => {
                quote = Some(quote_byte);
                output.push(quote_byte);
                index += 1;
            }
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                output.push(b' ');
                index += 2;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'#' => {
                output.push(b' ');
                index += 1;
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                output.push(b' ');
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == b'*' && bytes.get(index + 1) == Some(&b'/') {
                        index += 2;
                        break;
                    }
                    if bytes[index] == b'\n' {
                        output.push(b'\n');
                    }
                    index += 1;
                }
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8(output).expect("comment stripping preserves UTF-8 bytes")
}

fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_word_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn matching_delimiter(opening: u8) -> u8 {
    match opening {
        b'(' => b')',
        b'[' => b']',
        b'{' => b'}',
        _ => unreachable!("matching_delimiter accepts only opening delimiters"),
    }
}

fn validation_error(message: impl Into<String>) -> IpcError {
    IpcError::validation_failed(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn scanner_finds_only_top_level_clickhouse_clauses() {
        let sql = r#"
            CREATE TABLE `analytics`.`events`
            (`id` UInt64, `note` String DEFAULT 'ORDER BY hidden')
            ENGINE = ReplacingMergeTree(toDateTime64('2026-01-01 00:00:00', 3))
            PARTITION BY toYYYYMM(ts)
            ORDER BY (tenant_id, tuple(id, cityHash64(note)))
            SETTINGS index_granularity = 8192
        "#;

        let clauses = scan_table_clauses(sql).expect("scan clauses");

        assert_eq!(
            clauses.engine,
            "ReplacingMergeTree(toDateTime64('2026-01-01 00:00:00', 3))"
        );
        assert_eq!(clauses.partition_by.as_deref(), Some("toYYYYMM(ts)"));
        assert_eq!(clauses.order_by, "(tenant_id, tuple(id, cityHash64(note)))");
        assert_eq!(
            clauses.settings.as_deref(),
            Some("index_granularity = 8192")
        );
        assert!(clauses.table_body.contains("'ORDER BY hidden'"));
    }

    #[test]
    fn scanner_recognizes_single_line_canonical_clause_sequence() {
        let sql = "CREATE TABLE `analytics`.`events` (`id` UInt64) ENGINE = MergeTree PARTITION BY toYYYYMM(id) PRIMARY KEY id ORDER BY id TTL id + 1 DELETE SETTINGS index_granularity = 8192 COMMENT 'events'";

        let clauses = scan_table_clauses(sql).expect("scan single-line canonical CREATE");

        assert_eq!(clauses.engine, "MergeTree");
        assert_eq!(clauses.partition_by.as_deref(), Some("toYYYYMM(id)"));
        assert_eq!(clauses.primary_key.as_deref(), Some("id"));
        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.table_ttl.as_deref(), Some("id + 1 DELETE"));
        assert_eq!(
            clauses.settings.as_deref(),
            Some("index_granularity = 8192")
        );
        assert_eq!(clauses.comment.as_deref(), Some("'events'"));
        assert!(clauses.unknown_clauses.is_empty());
    }

    #[test]
    fn scanner_ignores_clause_words_inside_comments_and_quoted_identifiers() {
        let sql = r#"
            CREATE TABLE `analytics`.`ORDER BY`
            (
                `id` UInt64,
                `commented` String DEFAULT 'ENGINE = Hidden()'
            )
            -- PARTITION BY ignored
            ENGINE = MergeTree()
            /* SAMPLE BY ignored */
            ORDER BY id
            COMMENT 'SETTINGS hidden = 1'
        "#;

        let clauses = scan_table_clauses(sql).expect("scan clauses");

        assert_eq!(clauses.engine, "MergeTree()");
        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.comment.as_deref(), Some("'SETTINGS hidden = 1'"));
        assert!(clauses.partition_by.is_none());
        assert!(clauses.sample_by.is_none());
    }

    #[test]
    fn scanner_preserves_unknown_top_level_trailing_clause() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = MergeTree()
            ORDER BY id
            AS SELECT id FROM analytics.source
        "#;

        let clauses = scan_table_clauses(sql).expect("scan clauses");

        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.unknown_clauses.len(), 1);
        assert_eq!(
            clauses.unknown_clauses[0].raw,
            "AS SELECT id FROM analytics.source"
        );
    }

    #[test]
    fn scanner_does_not_treat_expression_identifiers_as_new_clauses() {
        let sql = r#"
            CREATE TABLE analytics.events (`engine` UInt64, `ttl` UInt64)
            ENGINE = MergeTree()
            ORDER BY engine + ttl
            SETTINGS engine = 1
        "#;

        let clauses = scan_table_clauses(sql).expect("scan keyword-like identifiers");

        assert_eq!(clauses.engine, "MergeTree()");
        assert_eq!(clauses.order_by, "engine + ttl");
        assert_eq!(clauses.settings.as_deref(), Some("engine = 1"));
    }

    #[test]
    fn scanner_rejects_non_create_headers_and_header_level_multiple_statements() {
        for sql in [
            "DROP TABLE t (`id` UInt64) ENGINE = MergeTree() ORDER BY id",
            "CREATE TABLE old; CREATE TABLE t (`id` UInt64) ENGINE = MergeTree() ORDER BY id",
        ] {
            let error = scan_table_clauses(sql).expect_err("invalid header must fail");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }

    #[test]
    fn scanner_preserves_unknown_future_clause_as_a_blocker_input() {
        let sql = r#"
            CREATE TABLE analytics.events (`id` UInt64)
            ENGINE = MergeTree()
            ORDER BY id
            FUTURE_CLAUSE x
        "#;

        let clauses = scan_table_clauses(sql).expect("scan future clause");

        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.unknown_clauses.len(), 1);
        assert_eq!(clauses.unknown_clauses[0].raw, "FUTURE_CLAUSE x");
    }

    #[test]
    fn scanner_keeps_clause_words_nested_in_array_and_map_expressions() {
        let sql = r#"
            CREATE TABLE analytics.events (`ttl` UInt64)
            ENGINE = MergeTree()
            ORDER BY [
                ttl,
                map('SETTINGS', ttl)
            ]
        "#;

        let clauses = scan_table_clauses(sql).expect("scan nested array/map expression");

        assert!(clauses.order_by.contains("ttl"));
        assert!(clauses.order_by.contains("map('SETTINGS', ttl)"));
        assert!(clauses.table_ttl.is_none());
        assert!(clauses.settings.is_none());

        let error =
            scan_table_clauses("CREATE TABLE t (`id` UInt64)\nENGINE = MergeTree()\nORDER BY [id")
                .expect_err("unclosed bracket must fail");
        assert_eq!(error.code, ErrorCode::ValidationFailed);
    }

    #[test]
    fn scanner_preserves_keyword_named_ttl_and_rejects_duplicate_clauses() {
        let ttl_sql = r#"
            CREATE TABLE analytics.events (`ttl` DateTime)
            ENGINE = MergeTree()
            ORDER BY ttl DESC
            TTL ttl DELETE
        "#;
        let clauses = scan_table_clauses(ttl_sql).expect("scan keyword-named TTL column");
        assert_eq!(clauses.order_by, "ttl DESC");
        assert_eq!(clauses.table_ttl.as_deref(), Some("ttl DELETE"));

        for duplicate in [
            r#"
                CREATE TABLE analytics.events (`id` UInt64)
                ENGINE = MergeTree()
                ENGINE = Log
                ORDER BY id
            "#,
            r#"
                CREATE TABLE analytics.events (`id` UInt64)
                ENGINE = MergeTree()
                ORDER BY id
                ORDER BY tuple()
            "#,
        ] {
            let error = scan_table_clauses(duplicate).expect_err("duplicate clause must fail");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }

    #[test]
    fn scanner_handles_inline_known_and_unknown_clause_tails() {
        let settings_sql = "CREATE TABLE analytics.events (`id` UInt64)\nENGINE = MergeTree()\nORDER BY id SETTINGS index_granularity = 8192";
        let clauses = scan_table_clauses(settings_sql).expect("scan inline SETTINGS");
        assert_eq!(clauses.order_by, "id");
        assert_eq!(
            clauses.settings.as_deref(),
            Some("index_granularity = 8192")
        );
        assert!(clauses.unknown_clauses.is_empty());

        let duplicate_sql = "CREATE TABLE analytics.events (`id` UInt64)\nENGINE = MergeTree()\nORDER BY id ORDER BY tuple()";
        let error = scan_table_clauses(duplicate_sql).expect_err("duplicate inline clause");
        assert_eq!(error.code, ErrorCode::ValidationFailed);

        let future_sql = "CREATE TABLE analytics.events (`id` UInt64)\nENGINE = MergeTree()\nORDER BY id FUTURE_CLAUSE x";
        let clauses = scan_table_clauses(future_sql).expect("retain unknown inline clause");
        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.unknown_clauses.len(), 1);
        assert_eq!(clauses.unknown_clauses[0].raw, "FUTURE_CLAUSE x");
    }

    #[test]
    fn scanner_fail_closes_single_word_unknown_inline_clause() {
        let sql =
            "CREATE TABLE analytics.events (`id` UInt64) ENGINE = MergeTree ORDER BY id FUTURE x";

        let clauses = scan_table_clauses(sql).expect("retain future single-word clause");

        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.unknown_clauses.len(), 1);
        assert_eq!(clauses.unknown_clauses[0].raw, "FUTURE x");
    }

    #[test]
    fn scanner_keeps_allowlisted_uppercase_expression_words_inline() {
        let sql = "CREATE TABLE analytics.events (`id` UInt64, `expires_at` DateTime) ENGINE = MergeTree ORDER BY id DESC TTL expires_at + INTERVAL 7 DAY DELETE";

        let clauses = scan_table_clauses(sql).expect("scan uppercase expression words");

        assert_eq!(clauses.order_by, "id DESC");
        assert_eq!(
            clauses.table_ttl.as_deref(),
            Some("expires_at + INTERVAL 7 DAY DELETE")
        );
        assert!(clauses.unknown_clauses.is_empty());
    }

    #[test]
    fn scanner_keeps_top_level_function_calls_inside_expressions() {
        let sql = "CREATE TABLE analytics.events (`id` UInt64, `version` UInt64, `expires_at` DateTime) ENGINE = MergeTree ORDER BY id + CAST(version AS UInt64) TTL CAST(expires_at AS DateTime) + INTERVAL 7 DAY DELETE";

        let clauses = scan_table_clauses(sql).expect("scan top-level function calls");

        assert_eq!(clauses.order_by, "id + CAST(version AS UInt64)");
        assert_eq!(
            clauses.table_ttl.as_deref(),
            Some("CAST(expires_at AS DateTime) + INTERVAL 7 DAY DELETE")
        );
        assert!(clauses.unknown_clauses.is_empty());
    }

    #[test]
    fn scanner_blocks_function_shaped_clause_after_complete_expression() {
        let sql = "CREATE TABLE analytics.events (`id` UInt64) ENGINE = MergeTree ORDER BY id FUTURE(option)";

        let clauses = scan_table_clauses(sql).expect("retain function-shaped future clause");

        assert_eq!(clauses.order_by, "id");
        assert_eq!(clauses.unknown_clauses.len(), 1);
        assert_eq!(clauses.unknown_clauses[0].raw, "FUTURE(option)");
    }

    #[test]
    fn scanner_tracks_logical_line_start_across_multiline_block_comments() {
        let sql = r#"
            CREATE TABLE analytics.events (`ttl` UInt64)
            ENGINE = MergeTree()
            ORDER BY
                ttl
            /* comment starts
            */ SETTINGS index_granularity = 8192
        "#;

        let clauses = scan_table_clauses(sql).expect("scan logical line boundaries");
        assert_eq!(clauses.order_by, "ttl");
        assert_eq!(
            clauses.settings.as_deref(),
            Some("index_granularity = 8192")
        );
        assert!(clauses.table_ttl.is_none());
        assert!(clauses.unknown_clauses.is_empty());
    }

    #[test]
    fn scanner_rejects_unclosed_quotes_comments_and_parentheses() {
        for sql in [
            "CREATE TABLE t (`id` String DEFAULT 'open) ENGINE = MergeTree() ORDER BY id",
            "CREATE TABLE t (`id` UInt64) /* open ENGINE = MergeTree() ORDER BY id",
            "CREATE TABLE t (`id` UInt64 ENGINE = MergeTree() ORDER BY id",
        ] {
            let error = scan_table_clauses(sql).expect_err("malformed SQL must fail");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }

    #[test]
    fn single_expression_boundary_accepts_nested_and_quoted_tokens() {
        for expression in [
            "tuple(id, cityHash64(note))",
            "map('semi;colon', 'line--comment', 'block/*comment*/')",
            "arrayMap(x -> (x + 1), [1, 2, 3])",
            "`semi;colon`",
            "\"hash#text\"",
        ] {
            assert!(validate_single_expression(expression, "expression").is_ok());
        }
    }

    #[test]
    fn single_expression_boundary_rejects_statement_comment_and_balance_breakouts() {
        for expression in [
            "",
            "   ",
            "id; DROP TABLE events",
            "id -- comment",
            "id # comment",
            "id /* comment */",
            "'unclosed",
            "tuple(id]",
            "tuple(id",
        ] {
            let error = validate_single_expression(expression, "expression")
                .expect_err("expression boundary must fail closed");
            assert_eq!(error.code, ErrorCode::ValidationFailed);
        }
    }

    #[test]
    fn identifier_reference_scanner_is_token_and_quote_aware() {
        assert!(expression_references_identifier(
            "cityHash64(id) + tupleElement(payload, 'id')",
            "id"
        ));
        assert!(expression_references_identifier("tuple(`id`)", "id"));
        assert!(!expression_references_identifier(
            "cityHash64(user_id)",
            "id"
        ));
        assert!(!expression_references_identifier("tuple('id')", "id"));
        assert!(!expression_references_identifier(
            "tuple(other) /* id */",
            "id"
        ));
    }
}
