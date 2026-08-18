use serde::{Deserialize, Serialize};

use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::types::SqlStatementClass;

pub const SQL_MAX_CHARS: usize = 64 * 1024;
pub const SQL_DEFAULT_PAGE_SIZE: u32 = 50;
pub const SQL_MAX_PAGE_SIZE: u32 = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqlToolRequest {
    pub profile_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

impl SqlToolRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.profile_id.trim().is_empty() {
            return Err("sql.execute profileId must not be empty");
        }
        if self.sql.trim().is_empty() {
            return Err("sql.execute SQL must not be empty");
        }
        if self.sql.chars().count() > SQL_MAX_CHARS {
            return Err("sql.execute SQL exceeds the maximum length");
        }
        if self.page_size == 0 || self.page_size > SQL_MAX_PAGE_SIZE {
            return Err("sql.execute pageSize is out of range");
        }
        for target in [&self.database, &self.schema].into_iter().flatten() {
            if target.trim().is_empty() || target.chars().count() > 256 {
                return Err("sql.execute target context is invalid");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SqlAnalysisStatus {
    Analyzed,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SqlToolStatementClass {
    Read,
    Insert,
    Update,
    Mutation,
    Delete,
    Ddl,
    Command,
    Unknown,
}

impl SqlToolStatementClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Insert => "insert",
            Self::Update => "update",
            Self::Mutation => "mutation",
            Self::Delete => "delete",
            Self::Ddl => "ddl",
            Self::Command => "command",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_mutation(self) -> bool {
        matches!(
            self,
            Self::Insert | Self::Update | Self::Mutation | Self::Delete | Self::Ddl | Self::Command
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlAnalysis {
    pub status: SqlAnalysisStatus,
    pub statement_class: SqlToolStatementClass,
    pub risk_level: &'static str,
    pub reversible: bool,
    pub side_effects: &'static [&'static str],
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedSqlPayload {
    pub request: SqlToolRequest,
    pub expected_driver: String,
    pub expected_profile_updated_at: i64,
    pub expected_read_only: bool,
    pub analysis_status: SqlAnalysisStatus,
    pub statement_class: SqlToolStatementClass,
}

pub fn analyze_sql_for_driver(driver: &str, sql: &str) -> Result<SqlAnalysis, &'static str> {
    match driver {
        "sqlite" => analyze_sqlite(frame_single_statement(sql, SqlFramingDialect::Sqlite)?),
        "mysql" => analyze_mysql(frame_single_statement(sql, SqlFramingDialect::Mysql)?),
        "postgres" => analyze_postgres(frame_single_statement(sql, SqlFramingDialect::Postgres)?),
        "oracle" => analyze_oracle(frame_single_statement(sql, SqlFramingDialect::Oracle)?),
        "clickhouse" => {
            let framing = frame_single_statement(sql, SqlFramingDialect::ClickHouse)?;
            let statement_class = ClickHouseDriver::classify_ai_sql(sql);
            analyze_clickhouse(framing, statement_class)
        }
        _ => Err("SQL execution for this driver has not passed its safety enablement gate"),
    }
}

fn analyze_sqlite(framing: StatementFraming) -> Result<SqlAnalysis, &'static str> {
    let keyword = framing.words.first().map(String::as_str).unwrap_or("");
    let contains = |candidate: &str| framing.words.iter().any(|word| word == candidate);
    let contains_any = |candidate: &str| framing.all_words.iter().any(|word| word == candidate);

    let analysis = match keyword {
        "SELECT" if contains_any("LOAD_EXTENSION") => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "SQLite extension loading can have effects outside a normal read query."
                    .to_string(),
            ],
        },
        "SELECT" | "VALUES" | "EXPLAIN" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "medium",
            reversible: true,
            side_effects: &["business_read"],
            reasons: vec!["SQLite classified the statement as read-only SQL.".to_string()],
        },
        "INSERT" | "REPLACE" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Insert,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The SQLite statement inserts or replaces business data.".to_string()],
        },
        "UPDATE" if contains("WHERE") => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Update,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The SQLite UPDATE contains a top-level WHERE clause.".to_string()],
        },
        "UPDATE" => destructive(
            SqlToolStatementClass::Update,
            "The SQLite UPDATE has no top-level WHERE clause.",
        ),
        "DELETE" => destructive(
            SqlToolStatementClass::Delete,
            "SQLite DELETE statements require destructive confirmation.",
        ),
        "CREATE" | "ALTER" | "DROP" | "VACUUM" | "REINDEX" | "ANALYZE" => destructive(
            SqlToolStatementClass::Ddl,
            "The SQLite statement can make irreversible schema or database changes.",
        ),
        "PRAGMA" | "ATTACH" | "DETACH" => destructive(
            SqlToolStatementClass::Command,
            "The SQLite command can change connection or database state.",
        ),
        "BEGIN" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" => {
            return Err("Cross-call SQLite transaction commands are not supported");
        }
        _ => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: classify_uncertain(keyword),
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "SQLite statement framing is valid, but its effects cannot be analyzed precisely."
                    .to_string(),
            ],
        },
    };
    Ok(analysis)
}

fn analyze_mysql(framing: StatementFraming) -> Result<SqlAnalysis, &'static str> {
    let keyword = main_statement_keyword(&framing.words);
    let contains = |candidate: &str| framing.words.iter().any(|word| word == candidate);
    let contains_any = |candidate: &str| framing.all_words.iter().any(|word| word == candidate);

    let analysis = match keyword {
        "SELECT" if contains("INTO") && (contains("OUTFILE") || contains("DUMPFILE")) => {
            destructive(
                SqlToolStatementClass::Command,
                "MySQL SELECT INTO OUTFILE/DUMPFILE writes outside the normal result channel.",
            )
        }
        "SELECT"
            if (contains_any("FOR") && (contains_any("UPDATE") || contains_any("SHARE")))
                || (contains_any("LOCK") && contains_any("SHARE")) =>
        {
            destructive(
                SqlToolStatementClass::Read,
                "The MySQL SELECT requests row locks and is not a side-effect-free read.",
            )
        }
        "SELECT"
            if ["GET_LOCK", "RELEASE_LOCK", "SLEEP", "BENCHMARK", "LOAD_FILE"]
                .iter()
                .any(|function| contains_any(function)) =>
        {
            destructive(
                SqlToolStatementClass::Read,
                "The MySQL SELECT invokes a server function with locking, resource, or file effects.",
            )
        }
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "medium",
            reversible: true,
            side_effects: &["business_read"],
            reasons: vec!["MySQL classified the statement as read-only SQL.".to_string()],
        },
        "INSERT" | "REPLACE" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Insert,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The MySQL statement inserts or replaces business data.".to_string()],
        },
        "UPDATE" if contains("WHERE") => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Update,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The MySQL UPDATE contains a top-level WHERE clause.".to_string()],
        },
        "UPDATE" => destructive(
            SqlToolStatementClass::Update,
            "The MySQL UPDATE has no top-level WHERE clause.",
        ),
        "DELETE" => destructive(
            SqlToolStatementClass::Delete,
            "MySQL DELETE statements require destructive confirmation.",
        ),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" => destructive(
            SqlToolStatementClass::Ddl,
            "The MySQL DDL statement can make irreversible schema or data changes.",
        ),
        "LOAD" => destructive(
            SqlToolStatementClass::Insert,
            "MySQL LOAD can import data from a server or client file source.",
        ),
        "GRANT" | "REVOKE" | "SET" | "USE" | "CALL" | "DO" | "KILL" | "RESET" | "FLUSH"
        | "PURGE" | "ANALYZE" | "OPTIMIZE" | "REPAIR" => destructive(
            SqlToolStatementClass::Command,
            "The MySQL command can change session, server, authorization, or stored state.",
        ),
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "LOCK" | "UNLOCK"
        | "XA" => {
            return Err("Cross-call MySQL transaction and lock commands are not supported");
        }
        _ => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: classify_uncertain(keyword),
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "MySQL statement framing is valid, but its effects cannot be analyzed precisely."
                    .to_string(),
            ],
        },
    };
    Ok(analysis)
}

fn analyze_postgres(framing: StatementFraming) -> Result<SqlAnalysis, &'static str> {
    let keyword = main_statement_keyword(&framing.words);
    let contains = |candidate: &str| framing.words.iter().any(|word| word == candidate);
    let contains_any = |candidate: &str| framing.all_words.iter().any(|word| word == candidate);
    let has_data_modifying_cte = framing.words.first().is_some_and(|word| word == "WITH")
        && ["INSERT", "UPDATE", "DELETE", "MERGE"]
            .iter()
            .any(|operation| contains_any(operation));

    let analysis = match keyword {
        "EXPLAIN" if contains_any("ANALYZE") => uncertain_critical(
            SqlToolStatementClass::Unknown,
            "PostgreSQL EXPLAIN ANALYZE can execute the explained statement, and its effects cannot be proven read-only from lexical framing.",
        ),
        "SELECT" if has_data_modifying_cte => uncertain_critical(
            SqlToolStatementClass::Mutation,
            "The PostgreSQL SELECT contains a data-modifying CTE whose business effects require conservative confirmation.",
        ),
        "SELECT"
            if contains_any("FOR")
                && (contains_any("UPDATE")
                    || contains_any("SHARE")
                    || contains_any("KEY")
                    || contains_any("NO")) =>
        {
            destructive(
                SqlToolStatementClass::Read,
                "The PostgreSQL SELECT requests row locks and is not a side-effect-free read.",
            )
        }
        "SELECT"
            if [
                "PG_SLEEP",
                "PG_ADVISORY_LOCK",
                "PG_TRY_ADVISORY_LOCK",
                "PG_READ_FILE",
                "PG_READ_BINARY_FILE",
                "LO_IMPORT",
                "LO_EXPORT",
            ]
            .iter()
            .any(|function| contains_any(function)) =>
        {
            destructive(
                SqlToolStatementClass::Read,
                "The PostgreSQL SELECT invokes a server function with locking, resource, or file effects.",
            )
        }
        "SELECT" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "medium",
            reversible: true,
            side_effects: &["business_read"],
            reasons: vec!["PostgreSQL classified the statement as read-only SQL.".to_string()],
        },
        "INSERT" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Insert,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The PostgreSQL statement inserts business data.".to_string()],
        },
        "UPDATE" if contains("WHERE") => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Update,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec![
                "The PostgreSQL UPDATE contains a top-level WHERE clause.".to_string(),
            ],
        },
        "UPDATE" => destructive(
            SqlToolStatementClass::Update,
            "The PostgreSQL UPDATE has no top-level WHERE clause.",
        ),
        "DELETE" => destructive(
            SqlToolStatementClass::Delete,
            "PostgreSQL DELETE statements require destructive confirmation.",
        ),
        "MERGE" => destructive(
            SqlToolStatementClass::Command,
            "PostgreSQL MERGE can combine insert, update, and delete effects.",
        ),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "REINDEX" | "REFRESH" | "CLUSTER"
        | "VACUUM" => destructive(
            SqlToolStatementClass::Ddl,
            "The PostgreSQL statement can make irreversible schema or database changes.",
        ),
        "COPY" => destructive(
            SqlToolStatementClass::Command,
            "PostgreSQL COPY can transfer table data or invoke server-side file/program I/O.",
        ),
        "GRANT" | "REVOKE" | "SET" | "RESET" | "DISCARD" | "LISTEN" | "NOTIFY"
        | "UNLISTEN" | "CALL" | "DO" | "SECURITY" | "COMMENT" | "ANALYZE" => destructive(
            SqlToolStatementClass::Command,
            "The PostgreSQL command can change session, server, authorization, or stored state.",
        ),
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE"
        | "PREPARE" | "EXECUTE" | "DEALLOCATE" => {
            return Err(
                "Cross-call PostgreSQL transaction and prepared-statement commands are not supported",
            );
        }
        _ => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: classify_uncertain(keyword),
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "PostgreSQL statement framing is valid, but its effects cannot be analyzed precisely."
                    .to_string(),
            ],
        },
    };
    Ok(analysis)
}

fn analyze_oracle(framing: StatementFraming) -> Result<SqlAnalysis, &'static str> {
    let keyword = main_statement_keyword(&framing.words);
    let contains = |candidate: &str| framing.words.iter().any(|word| word == candidate);
    let contains_any = |candidate: &str| framing.all_words.iter().any(|word| word == candidate);
    if framing.has_oracle_database_link {
        return Ok(destructive(
            classify_uncertain(keyword),
            "The Oracle statement references a database link outside the approved local target.",
        ));
    }

    let analysis = match keyword {
        "SELECT" if contains_any("FOR") && contains_any("UPDATE") => destructive(
            SqlToolStatementClass::Read,
            "The Oracle SELECT requests row locks and is not a side-effect-free read.",
        ),
        "SELECT"
            if [
                "DBMS_LOCK",
                "DBMS_PIPE",
                "UTL_FILE",
                "UTL_HTTP",
                "HTTPURITYPE",
                "DBMS_SCHEDULER",
            ]
            .iter()
            .any(|function| contains_any(function)) =>
        {
            destructive(
                SqlToolStatementClass::Read,
                "The Oracle SELECT invokes a package or function with locking, network, file, or scheduling effects.",
            )
        }
        "SELECT" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "medium",
            reversible: true,
            side_effects: &["business_read"],
            reasons: vec!["Oracle classified the statement as read-only SQL.".to_string()],
        },
        "INSERT" => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Insert,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The Oracle statement inserts business data.".to_string()],
        },
        "UPDATE" if contains("WHERE") => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Update,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The Oracle UPDATE contains a top-level WHERE clause.".to_string()],
        },
        "UPDATE" => destructive(
            SqlToolStatementClass::Update,
            "The Oracle UPDATE has no top-level WHERE clause.",
        ),
        "DELETE" => destructive(
            SqlToolStatementClass::Delete,
            "Oracle DELETE statements require destructive confirmation.",
        ),
        "MERGE" => destructive(
            SqlToolStatementClass::Command,
            "Oracle MERGE can combine insert, update, and delete effects.",
        ),
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "FLASHBACK" | "PURGE"
        | "ANALYZE" => destructive(
            SqlToolStatementClass::Ddl,
            "The Oracle statement can make irreversible schema or database changes.",
        ),
        "GRANT" | "REVOKE" | "AUDIT" | "NOAUDIT" | "CALL" | "EXPLAIN" => destructive(
            SqlToolStatementClass::Command,
            "The Oracle command can change authorization, stored state, or session-visible state.",
        ),
        "BEGIN" | "DECLARE" => {
            return Err("Oracle PL/SQL blocks are not supported by the single-statement executor");
        }
        "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "SET" | "LOCK" | "EXEC" | "EXECUTE" => {
            return Err("Cross-call Oracle transaction, lock, and session commands are not supported");
        }
        "PROMPT" | "SPOOL" | "REM" | "HOST" | "WHENEVER" | "DEFINE" | "ACCEPT"
        | "VARIABLE" | "PRINT" | "COLUMN" | "TTITLE" | "BTITLE" => {
            return Err("SQL*Plus client commands are not supported");
        }
        _ => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: classify_uncertain(keyword),
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "Oracle statement framing is valid, but its effects cannot be analyzed precisely."
                    .to_string(),
            ],
        },
    };
    Ok(analysis)
}

fn analyze_clickhouse(
    framing: StatementFraming,
    statement_class: SqlStatementClass,
) -> Result<SqlAnalysis, &'static str> {
    let contains = |candidate: &str| framing.words.iter().any(|word| word == candidate);
    if contains("FORMAT") || (contains("INTO") && contains("OUTFILE")) {
        return Err("ClickHouse FORMAT and INTO OUTFILE are not supported in bounded Grid mode");
    }

    let analysis = match statement_class {
        SqlStatementClass::Read => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Read,
            risk_level: "medium",
            reversible: true,
            side_effects: &["business_read"],
            reasons: vec![
                "The existing ClickHouse classifier identified a bounded read statement."
                    .to_string(),
            ],
        },
        SqlStatementClass::Insert => SqlAnalysis {
            status: SqlAnalysisStatus::Analyzed,
            statement_class: SqlToolStatementClass::Insert,
            risk_level: "high",
            reversible: false,
            side_effects: &["business_read", "business_write"],
            reasons: vec!["The ClickHouse statement inserts business data.".to_string()],
        },
        SqlStatementClass::Delete => destructive(
            SqlToolStatementClass::Delete,
            "ClickHouse DELETE can remove business data and may complete asynchronously.",
        ),
        SqlStatementClass::Mutation => destructive(
            SqlToolStatementClass::Mutation,
            "ClickHouse ALTER UPDATE/DELETE submits a server-side mutation whose completion may be asynchronous.",
        ),
        SqlStatementClass::Ddl => destructive(
            SqlToolStatementClass::Ddl,
            "The ClickHouse DDL statement can make irreversible schema or data changes.",
        ),
        SqlStatementClass::System | SqlStatementClass::Command => destructive(
            SqlToolStatementClass::Command,
            "The ClickHouse command can change server, session, or background execution state.",
        ),
        SqlStatementClass::Unknown => SqlAnalysis {
            status: SqlAnalysisStatus::Uncertain,
            statement_class: SqlToolStatementClass::Unknown,
            risk_level: "critical",
            reversible: false,
            side_effects: &["business_read", "business_write", "destructive"],
            reasons: vec![
                "ClickHouse statement framing is valid, but the existing classifier cannot determine its effects precisely."
                    .to_string(),
            ],
        },
    };
    Ok(analysis)
}

fn main_statement_keyword(words: &[String]) -> &str {
    let first = words.first().map(String::as_str).unwrap_or("");
    if first != "WITH" {
        return first;
    }
    words
        .iter()
        .skip(1)
        .map(String::as_str)
        .find(|word| {
            matches!(
                *word,
                "SELECT" | "INSERT" | "REPLACE" | "UPDATE" | "DELETE" | "MERGE"
            )
        })
        .unwrap_or("WITH")
}

fn destructive(class: SqlToolStatementClass, reason: &str) -> SqlAnalysis {
    SqlAnalysis {
        status: SqlAnalysisStatus::Analyzed,
        statement_class: class,
        risk_level: "critical",
        reversible: false,
        side_effects: &["business_read", "business_write", "destructive"],
        reasons: vec![reason.to_string()],
    }
}

fn uncertain_critical(class: SqlToolStatementClass, reason: &str) -> SqlAnalysis {
    SqlAnalysis {
        status: SqlAnalysisStatus::Uncertain,
        statement_class: class,
        risk_level: "critical",
        reversible: false,
        side_effects: &["business_read", "business_write", "destructive"],
        reasons: vec![reason.to_string()],
    }
}

fn classify_uncertain(keyword: &str) -> SqlToolStatementClass {
    match keyword {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "WITH" => SqlToolStatementClass::Read,
        "INSERT" | "MERGE" | "REPLACE" => SqlToolStatementClass::Insert,
        "UPDATE" => SqlToolStatementClass::Update,
        "DELETE" => SqlToolStatementClass::Delete,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" => SqlToolStatementClass::Ddl,
        "CALL" | "EXEC" | "EXECUTE" | "BEGIN" | "COMMIT" | "ROLLBACK" => {
            SqlToolStatementClass::Command
        }
        _ => SqlToolStatementClass::Unknown,
    }
}

struct StatementFraming {
    words: Vec<String>,
    all_words: Vec<String>,
    has_oracle_database_link: bool,
}

struct ScannedWord {
    value: String,
    depth: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScanState {
    Normal,
    SingleQuote,
    DoubleQuote,
    Backtick,
    BracketIdentifier,
    LineComment,
    BlockComment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SqlFramingDialect {
    Sqlite,
    Mysql,
    Postgres,
    Oracle,
    ClickHouse,
}

fn frame_single_statement(
    sql: &str,
    dialect: SqlFramingDialect,
) -> Result<StatementFraming, &'static str> {
    if sql.trim().is_empty() {
        return Err("SQL must not be empty");
    }
    if sql.chars().count() > SQL_MAX_CHARS {
        return Err("SQL exceeds the maximum length");
    }
    let trimmed = sql.trim_start();
    if trimmed.starts_with('\\') || trimmed.starts_with('!') || trimmed.starts_with('.') {
        return Err("Client or host commands are not supported");
    }
    if dialect == SqlFramingDialect::Oracle
        && (trimmed.starts_with('@')
            || trimmed == "/"
            || trimmed.starts_with("/\r")
            || trimmed.starts_with("/\n"))
    {
        return Err("SQL*Plus client commands are not supported");
    }

    let chars = sql.chars().collect::<Vec<_>>();
    let mut index = 0;
    let mut state = ScanState::Normal;
    let mut block_depth = 0_u32;
    let mut terminated = false;
    let mut words = Vec::<ScannedWord>::new();
    let mut current_word = String::new();
    let mut significant = false;
    let mut parenthesis_depth = 0_u32;
    let mut has_oracle_database_link = false;

    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        match state {
            ScanState::Normal => {
                let mysql_dash_comment = dialect == SqlFramingDialect::Mysql
                    && current == '-'
                    && next == Some('-')
                    && chars
                        .get(index + 2)
                        .is_some_and(|character| character.is_whitespace());
                let standard_dash_comment = matches!(
                    dialect,
                    SqlFramingDialect::Sqlite
                        | SqlFramingDialect::Postgres
                        | SqlFramingDialect::Oracle
                        | SqlFramingDialect::ClickHouse
                ) && current == '-'
                    && next == Some('-');
                if mysql_dash_comment || standard_dash_comment {
                    flush_word(&mut words, &mut current_word, parenthesis_depth);
                    state = ScanState::LineComment;
                    index += 2;
                    continue;
                }
                let mysql_hash_comment = dialect == SqlFramingDialect::Mysql && current == '#';
                let clickhouse_hash_comment = dialect == SqlFramingDialect::ClickHouse
                    && current == '#'
                    && next.is_none_or(|character| character == '!' || character.is_whitespace());
                if mysql_hash_comment || clickhouse_hash_comment {
                    flush_word(&mut words, &mut current_word, parenthesis_depth);
                    state = ScanState::LineComment;
                    index += 1;
                    continue;
                }
                if dialect == SqlFramingDialect::ClickHouse && current == '/' && next == Some('/') {
                    flush_word(&mut words, &mut current_word, parenthesis_depth);
                    state = ScanState::LineComment;
                    index += 2;
                    continue;
                }
                if current == '/' && next == Some('*') {
                    if dialect == SqlFramingDialect::Mysql
                        && (chars.get(index + 2) == Some(&'!')
                            || (chars
                                .get(index + 2)
                                .is_some_and(|character| character.eq_ignore_ascii_case(&'m'))
                                && chars.get(index + 3) == Some(&'!')))
                    {
                        return Err("MySQL executable comments are not supported");
                    }
                    flush_word(&mut words, &mut current_word, parenthesis_depth);
                    state = ScanState::BlockComment;
                    block_depth = 1;
                    index += 2;
                    continue;
                }
                if matches!(
                    dialect,
                    SqlFramingDialect::Postgres | SqlFramingDialect::ClickHouse
                ) && current == '$'
                {
                    if let Some(after_closing) = dollar_quote_end(&chars, index)? {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        if terminated {
                            return Err("Only one SQL statement is allowed");
                        }
                        significant = true;
                        index = after_closing;
                        continue;
                    }
                }
                if dialect == SqlFramingDialect::Oracle {
                    if let Some(after_closing) = oracle_q_quote_end(&chars, index)? {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        if terminated {
                            return Err("Only one SQL statement is allowed");
                        }
                        significant = true;
                        index = after_closing;
                        continue;
                    }
                    if current == '/' && oracle_line_only_slash(&chars, index) {
                        return Err("SQL*Plus client commands are not supported");
                    }
                }
                if current == ';' {
                    flush_word(&mut words, &mut current_word, parenthesis_depth);
                    if dialect == SqlFramingDialect::Oracle {
                        return Err(
                            "Oracle server SQL must not include a client statement terminator",
                        );
                    }
                    if terminated {
                        return Err("Only one SQL statement is allowed");
                    }
                    terminated = true;
                    index += 1;
                    continue;
                }
                if !current.is_whitespace() {
                    if terminated {
                        return Err("Only one SQL statement is allowed");
                    }
                    significant = true;
                }
                match current {
                    '\'' => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        state = ScanState::SingleQuote;
                    }
                    '"' => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        state = ScanState::DoubleQuote;
                    }
                    '`' if matches!(
                        dialect,
                        SqlFramingDialect::Sqlite
                            | SqlFramingDialect::Mysql
                            | SqlFramingDialect::ClickHouse
                    ) =>
                    {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        state = ScanState::Backtick;
                    }
                    '[' if dialect == SqlFramingDialect::Sqlite => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        state = ScanState::BracketIdentifier;
                    }
                    '(' => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        parenthesis_depth = parenthesis_depth.saturating_add(1);
                    }
                    ')' => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        if parenthesis_depth == 0 {
                            return Err("SQL contains unmatched parentheses");
                        }
                        parenthesis_depth -= 1;
                    }
                    '@' if dialect == SqlFramingDialect::Oracle => {
                        flush_word(&mut words, &mut current_word, parenthesis_depth);
                        has_oracle_database_link = true;
                    }
                    character if character.is_ascii_alphabetic() || character == '_' => {
                        current_word.push(character.to_ascii_uppercase());
                    }
                    character if character.is_ascii_digit() && !current_word.is_empty() => {
                        current_word.push(character);
                    }
                    _ => flush_word(&mut words, &mut current_word, parenthesis_depth),
                }
            }
            ScanState::SingleQuote | ScanState::DoubleQuote | ScanState::Backtick => {
                let delimiter = match state {
                    ScanState::SingleQuote => '\'',
                    ScanState::DoubleQuote => '"',
                    ScanState::Backtick => '`',
                    _ => unreachable!(),
                };
                if current == '\\' {
                    if dialect == SqlFramingDialect::ClickHouse {
                        index += 2;
                        continue;
                    }
                    return Err("Dialect-specific backslash quoting is not supported yet");
                }
                if current == delimiter {
                    if next == Some(delimiter) {
                        index += 2;
                        continue;
                    }
                    state = ScanState::Normal;
                }
            }
            ScanState::BracketIdentifier => {
                if current == ']' {
                    if next == Some(']') {
                        index += 2;
                        continue;
                    }
                    state = ScanState::Normal;
                }
            }
            ScanState::LineComment => {
                if current == '\n' || current == '\r' {
                    state = ScanState::Normal;
                }
            }
            ScanState::BlockComment => {
                if current == '/' && next == Some('*') {
                    if matches!(
                        dialect,
                        SqlFramingDialect::Mysql | SqlFramingDialect::Oracle
                    ) {
                        return Err("Nested block comments are not supported for this SQL dialect");
                    }
                    block_depth += 1;
                    index += 2;
                    continue;
                }
                if current == '*' && next == Some('/') {
                    block_depth -= 1;
                    index += 2;
                    if block_depth == 0 {
                        state = ScanState::Normal;
                    }
                    continue;
                }
            }
        }
        index += 1;
    }
    flush_word(&mut words, &mut current_word, parenthesis_depth);

    if state != ScanState::Normal && state != ScanState::LineComment {
        return Err("SQL contains an unterminated quoted value, identifier, or comment");
    }
    if parenthesis_depth != 0 {
        return Err("SQL contains unmatched parentheses");
    }
    if !significant || words.is_empty() {
        return Err("SQL must contain one statement");
    }
    let all_words = words
        .iter()
        .map(|word| word.value.clone())
        .collect::<Vec<_>>();
    let words = words
        .into_iter()
        .filter(|word| word.depth == 0)
        .map(|word| word.value)
        .collect::<Vec<_>>();
    if words.is_empty() {
        return Err("SQL must contain one top-level statement");
    }
    let first_word = words.first().map(String::as_str);
    if matches!(first_word, Some("DELIMITER" | "SOURCE"))
        || (dialect == SqlFramingDialect::Mysql && first_word == Some("SYSTEM"))
    {
        return Err("Client or host commands are not supported");
    }
    Ok(StatementFraming {
        words,
        all_words,
        has_oracle_database_link,
    })
}

fn oracle_q_quote_end(chars: &[char], start: usize) -> Result<Option<usize>, &'static str> {
    if start > 0
        && matches!(
            chars[start - 1],
            character
                if character.is_ascii_alphanumeric()
                    || character == '_'
                    || character == '$'
                    || character == '#'
        )
    {
        return Ok(None);
    }

    let q_index = if chars[start].eq_ignore_ascii_case(&'q') && chars.get(start + 1) == Some(&'\'')
    {
        start
    } else if chars[start].eq_ignore_ascii_case(&'n')
        && chars
            .get(start + 1)
            .is_some_and(|character| character.eq_ignore_ascii_case(&'q'))
        && chars.get(start + 2) == Some(&'\'')
    {
        start + 1
    } else {
        return Ok(None);
    };

    let Some(opening) = chars.get(q_index + 2).copied() else {
        return Err("Oracle alternative quoted value is unterminated");
    };
    if opening.is_whitespace() {
        return Err("Oracle alternative quoted value uses an invalid delimiter");
    }
    let closing = match opening {
        '[' => ']',
        '{' => '}',
        '(' => ')',
        '<' => '>',
        delimiter => delimiter,
    };
    let mut candidate = q_index + 3;
    while candidate + 1 < chars.len() {
        if chars[candidate] == closing && chars[candidate + 1] == '\'' {
            return Ok(Some(candidate + 2));
        }
        candidate += 1;
    }
    Err("Oracle alternative quoted value is unterminated")
}

fn oracle_line_only_slash(chars: &[char], index: usize) -> bool {
    let line_start = chars[..index]
        .iter()
        .rposition(|character| matches!(character, '\r' | '\n'))
        .map_or(0, |position| position + 1);
    let line_end = chars[index + 1..]
        .iter()
        .position(|character| matches!(character, '\r' | '\n'))
        .map_or(chars.len(), |position| index + 1 + position);
    chars[line_start..index]
        .iter()
        .all(|character| character.is_whitespace())
        && chars[index + 1..line_end]
            .iter()
            .all(|character| character.is_whitespace())
}

fn dollar_quote_end(chars: &[char], start: usize) -> Result<Option<usize>, &'static str> {
    if start > 0
        && matches!(
            chars[start - 1],
            character if character.is_ascii_alphanumeric() || character == '_' || character == '$'
        )
    {
        return Ok(None);
    }

    let mut tag_end = start + 1;
    while tag_end < chars.len() && chars[tag_end] != '$' {
        let character = chars[tag_end];
        let tag_offset = tag_end - start - 1;
        let valid = if tag_offset == 0 {
            character.is_ascii_alphabetic() || character == '_'
        } else {
            character.is_ascii_alphanumeric() || character == '_'
        };
        if !valid {
            return Ok(None);
        }
        tag_end += 1;
    }
    if tag_end >= chars.len() {
        return Ok(None);
    }

    let delimiter = &chars[start..=tag_end];
    let mut candidate = tag_end + 1;
    while candidate + delimiter.len() <= chars.len() {
        if &chars[candidate..candidate + delimiter.len()] == delimiter {
            return Ok(Some(candidate + delimiter.len()));
        }
        candidate += 1;
    }
    Err("Dollar-quoted value or block is unterminated")
}

fn flush_word(words: &mut Vec<ScannedWord>, current: &mut String, depth: u32) {
    if current.is_empty() {
        return;
    }
    words.push(ScannedWord {
        value: std::mem::take(current),
        depth,
    });
}

const fn default_page_size() -> u32 {
    SQL_DEFAULT_PAGE_SIZE
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_sql_for_driver, SqlAnalysisStatus, SqlToolRequest, SqlToolStatementClass,
        SQL_MAX_PAGE_SIZE,
    };

    #[test]
    fn frames_one_statement_without_counting_quoted_or_commented_semicolons() {
        for sql in [
            "SELECT ';' AS value;",
            "SELECT \"semi;colon\";",
            "SELECT `semi;colon`;",
            "SELECT [semi;colon];",
            "SELECT 1 /* ; */;",
            "SELECT 1 -- ;\n;",
        ] {
            assert!(analyze_sql_for_driver("sqlite", sql).is_ok(), "{sql}");
        }
        for sql in [
            "SELECT 1; SELECT 2",
            "SELECT 'unterminated",
            "SELECT 1 /* unterminated",
            "DELIMITER $$",
            "\\copy users TO file",
            "SELECT 'unsafe\\'quote'",
        ] {
            assert!(analyze_sql_for_driver("sqlite", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn classifies_analyzed_read_write_destructive_and_uncertain_sql() {
        let read =
            analyze_sql_for_driver("sqlite", "SELECT 1").expect("scalar read should analyze");
        assert_eq!(read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(read.risk_level, "medium");

        let insert = analyze_sql_for_driver("sqlite", "INSERT INTO users(id) VALUES (1)")
            .expect("insert should analyze");
        assert_eq!(insert.statement_class, SqlToolStatementClass::Insert);
        assert_eq!(insert.risk_level, "high");

        let destructive = analyze_sql_for_driver("sqlite", "UPDATE users SET active = 0")
            .expect("update should analyze");
        assert_eq!(destructive.statement_class, SqlToolStatementClass::Update);
        assert_eq!(destructive.risk_level, "critical");
        assert_eq!(
            analyze_sql_for_driver("sqlite", "UPDATE users SET active = (SELECT 1 WHERE 1 = 1)",)
                .expect("nested WHERE must still frame")
                .risk_level,
            "critical"
        );

        let uncertain = analyze_sql_for_driver(
            "sqlite",
            "WITH picked AS (SELECT * FROM users) SELECT * FROM picked",
        )
        .expect("single statement should frame");
        assert_eq!(uncertain.status, SqlAnalysisStatus::Uncertain);
        assert_eq!(uncertain.risk_level, "critical");
        assert!(uncertain.side_effects.contains(&"destructive"));
    }

    #[test]
    fn validates_target_sql_and_result_window() {
        let valid = SqlToolRequest {
            profile_id: "profile_1".to_string(),
            database: Some("app".to_string()),
            schema: None,
            sql: "SELECT 1".to_string(),
            page_size: SQL_MAX_PAGE_SIZE,
        };
        assert!(valid.validate().is_ok());
        assert!(SqlToolRequest {
            page_size: SQL_MAX_PAGE_SIZE + 1,
            ..valid.clone()
        }
        .validate()
        .is_err());
        assert!(SqlToolRequest {
            sql: " ".to_string(),
            ..valid
        }
        .validate()
        .is_err());
    }

    #[test]
    fn sqlite_analysis_is_precise_for_reads_and_gated_from_other_drivers() {
        let read = analyze_sql_for_driver("sqlite", "SELECT * FROM users")
            .expect("SQLite SELECT should analyze");
        assert_eq!(read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(read.risk_level, "medium");

        let load_extension =
            analyze_sql_for_driver("sqlite", "SELECT load_extension('unsafe_extension')")
                .expect("extension loading should remain conservatively analyzable");
        assert_eq!(load_extension.status, SqlAnalysisStatus::Uncertain);
        assert_eq!(load_extension.risk_level, "critical");
        assert_eq!(
            analyze_sql_for_driver(
                "sqlite",
                "SELECT (SELECT load_extension('unsafe_extension'))",
            )
            .expect("nested extension loading should be detected")
            .risk_level,
            "critical"
        );

        assert!(analyze_sql_for_driver("sqlite", "BEGIN").is_err());
    }

    #[test]
    fn mysql_framing_handles_comments_without_trusting_executable_comments() {
        for sql in [
            "SELECT ';' AS value;",
            "SELECT `semi;colon`;",
            "SELECT 1 # ; ignored\n;",
            "SELECT 1 -- ; ignored\n;",
            "SELECT 1 /* ; ignored */;",
        ] {
            assert!(analyze_sql_for_driver("mysql", sql).is_ok(), "{sql}");
        }
        for sql in [
            "SELECT 1--2; SELECT 2",
            "SELECT 1; # comment\nSELECT 2",
            "SELECT [unsafe; SELECT 2]",
            "/*!50000 DROP TABLE users */",
            "/*M!100100 DROP TABLE users */",
            "SELECT 'unsafe\\'quote'",
            "DELIMITER $$",
        ] {
            assert!(analyze_sql_for_driver("mysql", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn mysql_analysis_classifies_cte_writes_locks_and_external_output() {
        let cte_read =
            analyze_sql_for_driver("mysql", "WITH picked AS (SELECT 1) SELECT * FROM picked")
                .expect("MySQL CTE SELECT should analyze");
        assert_eq!(cte_read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(cte_read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(cte_read.risk_level, "medium");

        let cte_update = analyze_sql_for_driver(
            "mysql",
            "WITH picked AS (SELECT id FROM users) UPDATE users SET active = 0 WHERE id IN (SELECT id FROM picked)",
        )
        .expect("MySQL CTE UPDATE should analyze");
        assert_eq!(cte_update.statement_class, SqlToolStatementClass::Update);
        assert_eq!(cte_update.risk_level, "high");

        for sql in [
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users INTO OUTFILE '/tmp/users.csv'",
            "LOAD DATA INFILE '/tmp/users.csv' INTO TABLE users",
            "SELECT (SELECT SLEEP(1))",
        ] {
            let analysis =
                analyze_sql_for_driver("mysql", sql).expect("dangerous MySQL SQL should analyze");
            assert_eq!(analysis.risk_level, "critical", "{sql}");
        }

        assert!(analyze_sql_for_driver("mysql", "START TRANSACTION").is_err());
    }

    #[test]
    fn postgres_framing_supports_dollar_quotes_without_hiding_other_statements() {
        for sql in [
            "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;",
            "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN PERFORM 1; END $body$ LANGUAGE plpgsql;",
            "SELECT $tag$semi;colon$tag$;",
            "SELECT 1 /* outer /* nested ; */ comment */;",
        ] {
            assert!(analyze_sql_for_driver("postgres", sql).is_ok(), "{sql}");
        }
        for sql in [
            "DO $body$ BEGIN PERFORM 1; END;",
            "SELECT foo$tag$; SELECT 2",
            "SELECT `unsafe; SELECT 2`",
            "DO $$ BEGIN PERFORM 1; END $$; SELECT 2",
            "SELECT E'unsafe\\'quote'",
        ] {
            assert!(analyze_sql_for_driver("postgres", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn postgres_analysis_classifies_cte_copy_blocks_and_transactions() {
        let cte_read =
            analyze_sql_for_driver("postgres", "WITH picked AS (SELECT 1) SELECT * FROM picked")
                .expect("PostgreSQL CTE SELECT should analyze");
        assert_eq!(cte_read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(cte_read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(cte_read.risk_level, "medium");

        let cte_update = analyze_sql_for_driver(
            "postgres",
            "WITH picked AS (SELECT id FROM users) UPDATE users SET active = false WHERE id IN (SELECT id FROM picked)",
        )
        .expect("PostgreSQL CTE UPDATE should analyze");
        assert_eq!(cte_update.statement_class, SqlToolStatementClass::Update);
        assert_eq!(cte_update.risk_level, "high");

        let modifying_cte = analyze_sql_for_driver(
            "postgres",
            "WITH deleted AS (DELETE FROM audit_log WHERE created_at < now() RETURNING *) SELECT count(*) FROM deleted",
        )
        .expect("PostgreSQL data-modifying CTE should remain conservatively approvable");
        assert_eq!(modifying_cte.status, SqlAnalysisStatus::Uncertain);
        assert_eq!(
            modifying_cte.statement_class,
            SqlToolStatementClass::Mutation
        );
        assert_eq!(modifying_cte.risk_level, "critical");

        let plan_only = analyze_sql_for_driver("postgres", "EXPLAIN SELECT * FROM users")
            .expect("PostgreSQL plan-only EXPLAIN should remain a read analysis");
        assert_eq!(plan_only.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(plan_only.statement_class, SqlToolStatementClass::Read);
        assert_eq!(plan_only.risk_level, "medium");

        for sql in [
            "EXPLAIN ANALYZE DELETE FROM users WHERE id = 1",
            "EXPLAIN (ANALYZE, BUFFERS) UPDATE users SET active = false WHERE id = 1",
            "EXPLAIN (ANALYZE FALSE, COSTS FALSE) SELECT * FROM users",
        ] {
            let analysis = analyze_sql_for_driver("postgres", sql)
                .expect("PostgreSQL EXPLAIN ANALYZE should remain conservatively approvable");
            assert_eq!(analysis.status, SqlAnalysisStatus::Uncertain, "{sql}");
            assert_eq!(analysis.risk_level, "critical", "{sql}");
        }

        for sql in [
            "COPY users TO STDOUT",
            "COPY users FROM PROGRAM 'generate-users'",
            "DO $$ BEGIN PERFORM 1; END $$",
            "SELECT * FROM users FOR UPDATE",
            "SELECT (SELECT pg_sleep(1))",
        ] {
            let analysis = analyze_sql_for_driver("postgres", sql)
                .expect("dangerous PostgreSQL SQL should analyze");
            assert_eq!(analysis.risk_level, "critical", "{sql}");
        }

        assert!(analyze_sql_for_driver("postgres", "BEGIN").is_err());
        assert!(analyze_sql_for_driver("postgres", "PREPARE q AS SELECT 1").is_err());
    }

    #[test]
    fn oracle_framing_supports_alternative_quotes_without_accepting_client_scripts() {
        for sql in [
            "SELECT q'[John's value; remains one statement]' FROM dual",
            "SELECT q'{braces; (do not affect framing)}' FROM dual",
            "SELECT q'!custom; delimiter!' FROM dual",
            "SELECT q'aalphabetic; delimitera' FROM dual",
            "SELECT nq'<national; value>' FROM dual",
            "SELECT 1 -- ; ignored\nFROM dual",
            "SELECT 1 /* ; ignored */ FROM dual",
        ] {
            assert!(analyze_sql_for_driver("oracle", sql).is_ok(), "{sql}");
        }
        for sql in [
            "SELECT 1 FROM dual;",
            "SELECT q'[unterminated' FROM dual",
            "SELECT q' invalid delimiter ' FROM dual",
            "SELECT 1 /* outer /* nested */ comment */ FROM dual",
            "@unsafe.sql",
            "@@unsafe.sql",
            "/",
            "SELECT 1 FROM dual\n/\nSELECT 2 FROM dual",
            "SELECT `unsafe; SELECT 2` FROM dual",
            "SELECT [unsafe; SELECT 2] FROM dual",
        ] {
            assert!(analyze_sql_for_driver("oracle", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn oracle_analysis_classifies_ctes_database_links_blocks_and_commands() {
        let read = analyze_sql_for_driver(
            "oracle",
            "WITH picked AS (SELECT 1 AS id FROM dual) SELECT id FROM picked",
        )
        .expect("Oracle CTE SELECT should analyze");
        assert_eq!(read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(read.risk_level, "medium");

        let update = analyze_sql_for_driver("oracle", "UPDATE users SET active = 0 WHERE id = 1")
            .expect("Oracle UPDATE should analyze");
        assert_eq!(update.statement_class, SqlToolStatementClass::Update);
        assert_eq!(update.risk_level, "high");

        for sql in [
            "SELECT * FROM users FOR UPDATE",
            "SELECT * FROM users@remote_link",
            "SELECT UTL_HTTP.REQUEST('https://example.invalid') FROM dual",
            "SELECT (SELECT UTL_HTTP.REQUEST('https://example.invalid') FROM dual) FROM dual",
            "MERGE INTO users target USING staging source ON (target.id = source.id) WHEN MATCHED THEN UPDATE SET target.active = source.active",
            "DROP TABLE users",
            "UPSERT users SET active = 1",
        ] {
            let analysis =
                analyze_sql_for_driver("oracle", sql).expect("Oracle SQL should frame");
            assert_eq!(analysis.risk_level, "critical", "{sql}");
        }

        let uncertain = analyze_sql_for_driver("oracle", "WITH mystery AS (SELECT 1 FROM dual)")
            .expect("valid but incomplete effect classification should remain uncertain");
        assert_eq!(uncertain.status, SqlAnalysisStatus::Uncertain);
        assert_eq!(uncertain.risk_level, "critical");

        for sql in [
            "BEGIN NULL END",
            "DECLARE value NUMBER BEGIN NULL END",
            "COMMIT",
            "LOCK TABLE users IN EXCLUSIVE MODE",
            "EXEC dbms_lock.sleep(1)",
            "PROMPT unsafe",
        ] {
            assert!(analyze_sql_for_driver("oracle", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn clickhouse_framing_supports_native_quotes_comments_and_heredocs() {
        for sql in [
            "SELECT 'semi\\';colon'",
            "SELECT `semi;colon`",
            "SELECT $payload$semi;colon$payload$",
            "SELECT 1 /* outer /* nested ; */ comment */",
            "SELECT 1 // ; ignored\n",
            "SELECT 1 # ; ignored\n",
            "SELECT 1; -- trailing",
        ] {
            assert!(analyze_sql_for_driver("clickhouse", sql).is_ok(), "{sql}");
        }
        for sql in [
            "SELECT 1; SELECT 2",
            "SELECT 'unterminated",
            "SELECT `unterminated",
            "SELECT $payload$unterminated",
            "SELECT 1 /* unterminated",
            "SELECT 1 FORMAT CSV",
            "SELECT 1 INTO OUTFILE 'server.csv'",
            "SELECT 1 #not_a_comment; SELECT 2",
        ] {
            assert!(analyze_sql_for_driver("clickhouse", sql).is_err(), "{sql}");
        }
    }

    #[test]
    fn clickhouse_analysis_reuses_the_managed_statement_classifier() {
        let read = analyze_sql_for_driver("clickhouse", "WITH 1 AS n SELECT n")
            .expect("ClickHouse CTE read should analyze");
        assert_eq!(read.status, SqlAnalysisStatus::Analyzed);
        assert_eq!(read.statement_class, SqlToolStatementClass::Read);
        assert_eq!(read.risk_level, "medium");

        let insert = analyze_sql_for_driver("clickhouse", "INSERT INTO events VALUES (1)")
            .expect("ClickHouse INSERT should analyze");
        assert_eq!(insert.statement_class, SqlToolStatementClass::Insert);
        assert_eq!(insert.risk_level, "high");
        let nested_comment_insert = analyze_sql_for_driver(
            "clickhouse",
            "WITH x AS (SELECT 1 /* outer /* inner */ ) SELECT */) INSERT INTO events VALUES (1)",
        )
        .expect("nested comments must not hide the top-level ClickHouse mutation");
        assert_eq!(
            nested_comment_insert.statement_class,
            SqlToolStatementClass::Insert
        );

        let mutation = analyze_sql_for_driver(
            "clickhouse",
            "ALTER TABLE events UPDATE active = 0 WHERE id = 1",
        )
        .expect("ClickHouse mutation should analyze");
        assert_eq!(mutation.statement_class, SqlToolStatementClass::Mutation);
        assert_eq!(mutation.risk_level, "critical");

        let unknown = analyze_sql_for_driver("clickhouse", "FUTURE COMMAND")
            .expect("framed unknown ClickHouse SQL should remain approvable");
        assert_eq!(unknown.status, SqlAnalysisStatus::Uncertain);
        assert_eq!(unknown.risk_level, "critical");

        let system = analyze_sql_for_driver("clickhouse", "SYSTEM FLUSH LOGS")
            .expect("ClickHouse SYSTEM should analyze");
        assert_eq!(system.statement_class, SqlToolStatementClass::Command);
        assert_eq!(system.risk_level, "critical");
    }
}
