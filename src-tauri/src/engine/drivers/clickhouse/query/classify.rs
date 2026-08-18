use crate::engine::drivers::common::sql_is_single_statement;
use crate::engine::types::{SqlResultMode, SqlStatementClass};
use crate::error::{IpcError, IpcResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RawSqlDirectives {
    pub format: Option<String>,
    pub into_outfile: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TopLevelToken {
    normalized: String,
    original: String,
}

#[allow(dead_code)]
pub(super) fn classify_statement(sql: &str) -> IpcResult<SqlStatementClass> {
    let tokens = validated_top_level_tokens(sql)?;
    Ok(classify_tokens(&tokens))
}

pub(super) fn classify_framed_statement(sql: &str) -> SqlStatementClass {
    classify_tokens(&scan_top_level_tokens(sql))
}

pub(super) fn raw_sql_directives(sql: &str) -> IpcResult<RawSqlDirectives> {
    let tokens = validated_top_level_tokens(sql)?;
    let format = tokens.windows(2).find_map(|tokens| {
        (tokens[0].normalized == "FORMAT" && !tokens[1].normalized.is_empty())
            .then(|| tokens[1].original.clone())
    });
    let into_outfile = tokens
        .windows(2)
        .any(|tokens| tokens[0].normalized == "INTO" && tokens[1].normalized == "OUTFILE");
    Ok(RawSqlDirectives {
        format,
        into_outfile,
    })
}

pub(super) fn validate_managed_sql(sql: &str, mode: SqlResultMode) -> IpcResult<()> {
    let tokens = validated_top_level_tokens(sql)?;
    if mode == SqlResultMode::Grid && tokens.iter().any(|token| token.normalized == "FORMAT") {
        return Err(IpcError::validation_failed(
            "ClickHouse FORMAT clauses are managed by NexusPilot",
        ));
    }
    if mode == SqlResultMode::Grid
        && tokens
            .windows(2)
            .any(|tokens| tokens[0].normalized == "INTO" && tokens[1].normalized == "OUTFILE")
    {
        return Err(IpcError::validation_failed(
            "ClickHouse INTO OUTFILE is not available in this result mode",
        ));
    }
    Ok(())
}

fn validated_top_level_tokens(sql: &str) -> IpcResult<Vec<TopLevelToken>> {
    if !sql_is_single_statement(sql) {
        return Err(IpcError::validation_failed(
            "ClickHouse SQL must contain exactly one statement",
        ));
    }

    let tokens = scan_top_level_tokens(sql);
    if !tokens.iter().any(|token| !token.normalized.is_empty()) {
        return Err(IpcError::validation_failed(
            "ClickHouse SQL cannot be empty",
        ));
    }
    Ok(tokens)
}

fn classify_tokens(tokens: &[TopLevelToken]) -> SqlStatementClass {
    let words = tokens
        .iter()
        .map(|token| token.normalized.as_str())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    if words.first() != Some(&"WITH") {
        return classify_leading(&words);
    }
    let operation = words.iter().enumerate().skip(1).find_map(|(index, token)| {
        matches!(
            *token,
            "SELECT"
                | "INSERT"
                | "DELETE"
                | "CREATE"
                | "DROP"
                | "ALTER"
                | "SYSTEM"
                | "SET"
                | "USE"
                | "OPTIMIZE"
                | "CHECK"
                | "KILL"
        )
        .then_some(index)
    });
    operation
        .map(|index| classify_leading(&words[index..]))
        .unwrap_or(SqlStatementClass::Unknown)
}

fn classify_leading(words: &[&str]) -> SqlStatementClass {
    match words.first().copied().unwrap_or_default() {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXISTS" | "EXPLAIN" => SqlStatementClass::Read,
        "CREATE" | "DROP" | "RENAME" | "TRUNCATE" | "ATTACH" | "DETACH" => SqlStatementClass::Ddl,
        "ALTER"
            if words
                .iter()
                .any(|token| matches!(*token, "UPDATE" | "DELETE")) =>
        {
            SqlStatementClass::Mutation
        }
        "ALTER" => SqlStatementClass::Ddl,
        "INSERT" => SqlStatementClass::Insert,
        "DELETE" => SqlStatementClass::Delete,
        "SYSTEM" => SqlStatementClass::System,
        "SET" | "USE" | "OPTIMIZE" | "CHECK" | "KILL" => SqlStatementClass::Command,
        _ => SqlStatementClass::Unknown,
    }
}

fn scan_top_level_tokens(sql: &str) -> Vec<TopLevelToken> {
    let bytes = sql.as_bytes();
    let mut position = 0;
    let mut depth = 0_usize;
    let mut tokens = Vec::new();

    while position < bytes.len() {
        match bytes[position] {
            b'\'' | b'"' | b'`' => {
                if depth == 0 {
                    push_token_boundary(&mut tokens);
                }
                position = skip_quoted(bytes, position, bytes[position]);
            }
            b'-' if bytes.get(position + 1) == Some(&b'-') => {
                position = skip_line_comment(bytes, position + 2);
            }
            b'#' if bytes
                .get(position + 1)
                .is_none_or(|next| *next == b'!' || next.is_ascii_whitespace()) =>
            {
                position = skip_line_comment(bytes, position + 1);
            }
            b'/' if bytes.get(position + 1) == Some(&b'/') => {
                position = skip_line_comment(bytes, position + 2);
            }
            b'/' if bytes.get(position + 1) == Some(&b'*') => {
                position = skip_nested_block_comment(bytes, position + 2);
            }
            b'$' => {
                if let Some(after_closing) = clickhouse_heredoc_end(bytes, position) {
                    if depth == 0 {
                        push_token_boundary(&mut tokens);
                    }
                    position = after_closing;
                } else {
                    position += 1;
                }
            }
            b'(' => {
                if depth == 0 {
                    push_token_boundary(&mut tokens);
                }
                depth = depth.saturating_add(1);
                position += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    push_token_boundary(&mut tokens);
                }
                position += 1;
            }
            byte if byte.is_ascii_alphanumeric() || byte == b'_' => {
                let start = position;
                position += 1;
                while bytes
                    .get(position)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    position += 1;
                }
                if depth == 0 {
                    let original = sql[start..position].to_string();
                    tokens.push(TopLevelToken {
                        normalized: original.to_ascii_uppercase(),
                        original,
                    });
                }
            }
            byte if byte.is_ascii_whitespace() => position += 1,
            _ => {
                if depth == 0 {
                    push_token_boundary(&mut tokens);
                }
                position += 1;
            }
        }
    }

    tokens
}

fn push_token_boundary(tokens: &mut Vec<TopLevelToken>) {
    if tokens
        .last()
        .is_some_and(|token| !token.normalized.is_empty())
    {
        tokens.push(TopLevelToken {
            normalized: String::new(),
            original: String::new(),
        });
    }
}

fn skip_quoted(bytes: &[u8], mut position: usize, quote: u8) -> usize {
    position += 1;
    while position < bytes.len() {
        if bytes[position] == b'\\' && quote == b'\'' {
            position = (position + 2).min(bytes.len());
            continue;
        }
        if bytes[position] == quote {
            if bytes.get(position + 1) == Some(&quote) {
                position += 2;
                continue;
            }
            return position + 1;
        }
        position += 1;
    }
    position
}

fn skip_line_comment(bytes: &[u8], mut position: usize) -> usize {
    while position < bytes.len() && bytes[position] != b'\n' {
        position += 1;
    }
    position
}

fn skip_nested_block_comment(bytes: &[u8], mut position: usize) -> usize {
    let mut depth = 1_u32;
    while position + 1 < bytes.len() {
        if bytes[position] == b'/' && bytes[position + 1] == b'*' {
            depth = depth.saturating_add(1);
            position += 2;
            continue;
        }
        if bytes[position] == b'*' && bytes[position + 1] == b'/' {
            depth -= 1;
            position += 2;
            if depth == 0 {
                return position;
            }
            continue;
        }
        position += 1;
    }
    bytes.len()
}

fn clickhouse_heredoc_end(bytes: &[u8], start: usize) -> Option<usize> {
    if start > 0
        && matches!(
            bytes[start - 1],
            byte if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
        )
    {
        return None;
    }
    let mut tag_end = start + 1;
    while tag_end < bytes.len() && bytes[tag_end] != b'$' {
        if !(bytes[tag_end].is_ascii_alphanumeric() || bytes[tag_end] == b'_') {
            return None;
        }
        tag_end += 1;
    }
    if tag_end >= bytes.len() {
        return None;
    }
    let delimiter = &bytes[start..=tag_end];
    let mut candidate = tag_end + 1;
    while candidate + delimiter.len() <= bytes.len() {
        if &bytes[candidate..candidate + delimiter.len()] == delimiter {
            return Some(candidate + delimiter.len());
        }
        candidate += 1;
    }
    Some(bytes.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_clickhouse_statements_for_presentation() {
        for (sql, expected) in [
            ("SELECT 1", SqlStatementClass::Read),
            ("WITH 1 AS n SELECT n", SqlStatementClass::Read),
            ("EXPLAIN PIPELINE SELECT 1", SqlStatementClass::Read),
            ("SHOW TABLES", SqlStatementClass::Read),
            ("DESCRIBE TABLE t", SqlStatementClass::Read),
            (
                "CREATE TABLE t (id UInt64) ENGINE=Memory",
                SqlStatementClass::Ddl,
            ),
            ("ALTER TABLE t ADD COLUMN x UInt8", SqlStatementClass::Ddl),
            ("INSERT INTO t VALUES (1)", SqlStatementClass::Insert),
            ("DELETE FROM t WHERE id = 1", SqlStatementClass::Delete),
            (
                "ALTER TABLE t UPDATE x = 1 WHERE id = 1",
                SqlStatementClass::Mutation,
            ),
            (
                "ALTER TABLE t DELETE WHERE id = 1",
                SqlStatementClass::Mutation,
            ),
            ("SYSTEM FLUSH LOGS", SqlStatementClass::System),
            ("SET max_threads = 1", SqlStatementClass::Command),
            ("FUTURE COMMAND", SqlStatementClass::Unknown),
        ] {
            assert_eq!(classify_statement(sql).unwrap(), expected, "{sql}");
        }
    }

    #[test]
    fn classifier_ignores_keywords_in_quotes_comments_and_nested_queries() {
        assert_eq!(
            classify_statement("/* INSERT */ SELECT 'ALTER', (SELECT 'DELETE')").unwrap(),
            SqlStatementClass::Read,
        );
        assert_eq!(
            classify_statement("WITH x AS (SELECT 'CREATE') SELECT * FROM x").unwrap(),
            SqlStatementClass::Read,
        );
        assert_eq!(
            classify_statement("ALTER TABLE t UPDATE note = 'DELETE' WHERE id = 1").unwrap(),
            SqlStatementClass::Mutation,
        );
        assert_eq!(
            classify_framed_statement(
                "WITH x AS (SELECT 1 /* outer /* inner */ ) SELECT */) INSERT INTO t VALUES (1)"
            ),
            SqlStatementClass::Insert,
        );
        assert_eq!(
            classify_framed_statement(
                "WITH x AS (SELECT $payload$) INSERT DELETE$payload$) INSERT INTO t VALUES (1)"
            ),
            SqlStatementClass::Insert,
        );
        assert_eq!(
            classify_framed_statement(
                "WITH x AS (SELECT 1 // ) SELECT\n) INSERT INTO t VALUES (1)"
            ),
            SqlStatementClass::Insert,
        );
    }

    #[test]
    fn grid_guard_owns_format_while_raw_preserves_original_sql() {
        assert!(validate_managed_sql("SELECT 1 FORMAT CSV", SqlResultMode::Grid).is_err());
        assert!(validate_managed_sql("SELECT 1 FORMAT CSV", SqlResultMode::Raw).is_ok());
        assert!(
            validate_managed_sql("SELECT 1 INTO OUTFILE 'server.csv'", SqlResultMode::Raw,).is_ok()
        );
        assert!(validate_managed_sql("SELECT 'FORMAT CSV'", SqlResultMode::Grid).is_ok());
        assert!(validate_managed_sql("SELECT 1; SELECT 2", SqlResultMode::Raw).is_err());
        assert!(validate_managed_sql("-- comment only", SqlResultMode::Grid).is_err());
        assert!(
            validate_managed_sql("SELECT `FORMAT`, \"OUTFILE\" FROM t", SqlResultMode::Grid)
                .is_ok()
        );
        assert!(validate_managed_sql(
            "SELECT 'a; b', (SELECT 'INTO OUTFILE')",
            SqlResultMode::Grid,
        )
        .is_ok());
        assert!(validate_managed_sql("SELECT 1 -- FORMAT JSON\n", SqlResultMode::Grid).is_ok());
        assert!(validate_managed_sql("SELECT 1 # INTO OUTFILE\n", SqlResultMode::Grid).is_ok());
        assert!(validate_managed_sql(
            "SELECT 1 INTO /* boundary */ OUTFILE 'x'",
            SqlResultMode::Grid,
        )
        .is_err());
        assert!(validate_managed_sql("SELECT INTO, OUTFILE FROM t", SqlResultMode::Grid).is_ok());
        assert!(
            validate_managed_sql("SELECT INTO 'literal' OUTFILE FROM t", SqlResultMode::Grid,)
                .is_ok()
        );
    }

    #[test]
    fn raw_directives_preserve_format_spelling_and_detect_top_level_outfile() {
        assert_eq!(
            raw_sql_directives("SELECT 1 FORMAT CSVWithNames").unwrap(),
            RawSqlDirectives {
                format: Some("CSVWithNames".to_string()),
                into_outfile: false,
            },
        );
        assert_eq!(
            raw_sql_directives("SELECT 1 INTO /* gap */ OUTFILE 'server.csv' FORMAT JSONEachRow",)
                .unwrap(),
            RawSqlDirectives {
                format: Some("JSONEachRow".to_string()),
                into_outfile: true,
            },
        );
    }

    #[test]
    fn raw_directives_ignore_quotes_comments_and_nested_queries() {
        for sql in [
            "SELECT 'FORMAT CSV', `INTO`, \"OUTFILE\"",
            "SELECT 1 -- FORMAT CSV\n",
            "SELECT 1 # INTO OUTFILE\n",
            "SELECT 1 /* FORMAT JSON INTO OUTFILE */",
            "SELECT * FROM (SELECT 1 FORMAT CSV)",
            "SELECT (SELECT 'x' INTO OUTFILE 'nested')",
        ] {
            assert_eq!(
                raw_sql_directives(sql).unwrap(),
                RawSqlDirectives {
                    format: None,
                    into_outfile: false,
                },
                "{sql}",
            );
        }
    }

    #[test]
    fn raw_directives_reuse_single_statement_and_empty_validation() {
        assert!(raw_sql_directives("SELECT 1; SELECT 2").is_err());
        assert!(raw_sql_directives("-- comment only").is_err());
    }
}
