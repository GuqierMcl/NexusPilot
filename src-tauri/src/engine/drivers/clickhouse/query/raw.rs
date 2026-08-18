use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use tokio::sync::watch;
use tokio::sync::OwnedMutexGuard;

use super::classify::RawSqlDirectives;
use super::policy::ExecutionPolicy;
use crate::engine::drivers::clickhouse::ClickHouseDriver;
use crate::engine::sql_execution::artifact::{
    RawArtifactDescriptor, RawArtifactPreviewMode, RawArtifactWriter,
};
use crate::engine::types::SqlExecutionSummary;
use crate::error::{IpcError, IpcResult};

pub(super) const DEFAULT_RAW_FORMAT: &str = "TabSeparatedRaw";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RawQueryCall {
    pub database: Option<String>,
    pub sql: String,
    pub query_id: String,
    pub timeout_ms: Option<u64>,
    pub directives: RawSqlDirectives,
}

#[derive(Debug, Clone)]
pub(super) enum RawQueryOutcome {
    Artifact {
        format: String,
        media_type: String,
        descriptor: RawArtifactDescriptor,
        summary: Option<SqlExecutionSummary>,
    },
    ServerOutfile {
        summary: Option<SqlExecutionSummary>,
    },
}

#[async_trait]
trait RawByteSource: Send {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError>;

    fn summary(&self) -> Option<SqlExecutionSummary> {
        None
    }
}

struct ClickHouseRawByteSource {
    cursor: clickhouse::query::BytesCursor,
    _session_guard: Option<OwnedMutexGuard<()>>,
}

#[async_trait]
impl RawByteSource for ClickHouseRawByteSource {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError> {
        self.cursor
            .next()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
    }

    fn summary(&self) -> Option<SqlExecutionSummary> {
        self.cursor.summary().map(super::summary::from_clickhouse)
    }
}

#[async_trait]
trait RawQueryExecutor: Send + Sync {
    async fn open_raw(
        &self,
        call: RawQueryCall,
        default_format: &'static str,
    ) -> IpcResult<Box<dyn RawByteSource>>;
}

#[async_trait]
impl RawQueryExecutor for ClickHouseDriver {
    async fn open_raw(
        &self,
        call: RawQueryCall,
        default_format: &'static str,
    ) -> IpcResult<Box<dyn RawByteSource>> {
        let (base_client, session_guard) = self.client_for_request().await?;
        let client = call
            .database
            .as_deref()
            .map(|database| base_client.clone().with_database(database))
            .unwrap_or(base_client);
        let query = ExecutionPolicy::DirectRaw
            .apply(client.query(&call.sql), call.timeout_ms)
            .with_setting("query_id", &call.query_id);
        let cursor = query
            .fetch_bytes(default_format)
            .map_err(|error| super::super::error::classify_query_error(error, "start Raw query"))?;
        Ok(Box::new(ClickHouseRawByteSource {
            cursor,
            _session_guard: session_guard,
        }))
    }
}

pub(super) async fn execute_raw(
    driver: &ClickHouseDriver,
    call: RawQueryCall,
    writer: RawArtifactWriter,
    cancellation: watch::Receiver<bool>,
) -> IpcResult<RawQueryOutcome> {
    execute_raw_with(driver, call, writer, cancellation).await
}

async fn execute_raw_with<E: RawQueryExecutor>(
    executor: &E,
    call: RawQueryCall,
    mut writer: RawArtifactWriter,
    mut cancellation: watch::Receiver<bool>,
) -> IpcResult<RawQueryOutcome> {
    if *cancellation.borrow() {
        return Err(raw_query_canceled());
    }
    let effective_format = call
        .directives
        .format
        .clone()
        .unwrap_or_else(|| DEFAULT_RAW_FORMAT.to_string());
    let into_outfile = call.directives.into_outfile;
    let (media_type, preview_mode) = format_presentation(&effective_format);
    let mut source = executor.open_raw(call, DEFAULT_RAW_FORMAT).await?;
    if *cancellation.borrow() {
        return Err(raw_query_canceled());
    }
    let mut byte_length = 0_u64;

    loop {
        let next_chunk = tokio::select! {
            biased;
            changed = cancellation.changed() => {
                let _ = changed;
                return Err(raw_query_canceled());
            }
            result = source.next_chunk() => result,
        }
        .map_err(|error| {
            super::super::error::classify_query_error(error, "read Raw query result")
        })?;

        let Some(chunk) = next_chunk else {
            let summary = source.summary();
            if into_outfile && byte_length == 0 {
                writer.abort()?;
                return Ok(RawQueryOutcome::ServerOutfile { summary });
            }
            let descriptor = writer.finish(preview_mode)?;
            return Ok(RawQueryOutcome::Artifact {
                format: effective_format,
                media_type: media_type.to_string(),
                descriptor,
                summary,
            });
        };

        if *cancellation.borrow() {
            return Err(raw_query_canceled());
        }
        writer.write_chunk(&chunk)?;
        byte_length = byte_length.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        if *cancellation.borrow() {
            return Err(raw_query_canceled());
        }
    }
}

fn format_presentation(format: &str) -> (&'static str, RawArtifactPreviewMode) {
    let normalized = format.to_ascii_uppercase();
    let media_type = if normalized.starts_with("CSV") {
        "text/csv"
    } else if normalized.starts_with("TSV") || normalized.starts_with("TABSEPARATED") {
        "text/tab-separated-values"
    } else if normalized.starts_with("JSON") {
        "application/json"
    } else if normalized.starts_with("XML") {
        "application/xml"
    } else if normalized.starts_with("PARQUET") {
        "application/vnd.apache.parquet"
    } else if normalized.starts_with("ARROW") {
        "application/vnd.apache.arrow.stream"
    } else {
        "application/octet-stream"
    };
    let preview_mode = if normalized.starts_with("PARQUET")
        || normalized.starts_with("ARROW")
        || matches!(normalized.as_str(), "NATIVE" | "ORC" | "AVRO")
    {
        RawArtifactPreviewMode::Binary
    } else {
        RawArtifactPreviewMode::Text
    };
    (media_type, preview_mode)
}

fn raw_query_canceled() -> IpcError {
    IpcError::operation_canceled(
        "ClickHouse Raw query canceled",
        "managed Raw execution cancellation was requested",
    )
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::drivers::clickhouse::query::classify::raw_sql_directives;
    use crate::engine::sql_execution::artifact::{
        RawArtifactLimits, RawArtifactOwner, RawArtifactStore, RawArtifactWriter,
    };
    use crate::engine::types::{SqlExecutionSummary, SqlSummaryCompleteness, SqlSummarySource};
    use crate::error::{ErrorCode, IpcResult};

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordedRawCall {
        call: RawQueryCall,
        default_format: String,
    }

    struct FakeRawSource {
        chunks: VecDeque<Result<Vec<u8>, ClickHouseError>>,
        summary: Option<SqlExecutionSummary>,
    }

    #[async_trait]
    impl RawByteSource for FakeRawSource {
        async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, ClickHouseError> {
            self.chunks.pop_front().transpose()
        }

        fn summary(&self) -> Option<SqlExecutionSummary> {
            self.summary.clone()
        }
    }

    struct RecordingRawExecutor {
        calls: Mutex<Vec<RecordedRawCall>>,
        source: Mutex<Option<FakeRawSource>>,
    }

    impl RecordingRawExecutor {
        fn chunks(chunks: impl IntoIterator<Item = Result<Vec<u8>, ClickHouseError>>) -> Self {
            Self::with_summary(chunks, None)
        }

        fn with_summary(
            chunks: impl IntoIterator<Item = Result<Vec<u8>, ClickHouseError>>,
            summary: Option<SqlExecutionSummary>,
        ) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                source: Mutex::new(Some(FakeRawSource {
                    chunks: chunks.into_iter().collect(),
                    summary,
                })),
            }
        }

        fn calls(&self) -> Vec<RecordedRawCall> {
            self.calls.lock().expect("Raw calls lock").clone()
        }
    }

    #[async_trait]
    impl RawQueryExecutor for RecordingRawExecutor {
        async fn open_raw(
            &self,
            call: RawQueryCall,
            default_format: &'static str,
        ) -> IpcResult<Box<dyn RawByteSource>> {
            self.calls
                .lock()
                .expect("Raw calls lock")
                .push(RecordedRawCall {
                    call,
                    default_format: default_format.to_string(),
                });
            Ok(Box::new(
                self.source
                    .lock()
                    .expect("Raw source lock")
                    .take()
                    .expect("single Raw source"),
            ))
        }
    }

    fn call(sql: &str) -> RawQueryCall {
        RawQueryCall {
            database: Some("analytics".to_string()),
            sql: sql.to_string(),
            query_id: "query-1".to_string(),
            timeout_ms: Some(30_000),
            directives: raw_sql_directives(sql).expect("valid Raw SQL"),
        }
    }

    fn artifact(max_bytes: u64) -> (tempfile::TempDir, RawArtifactStore, RawArtifactWriter) {
        let root = tempfile::tempdir().expect("Raw artifact root");
        let store = RawArtifactStore::for_test(
            root.path().to_path_buf(),
            RawArtifactLimits {
                max_bytes,
                preview_bytes: 64,
                binary_preview_bytes: 16,
            },
        );
        let writer = store
            .start(RawArtifactOwner {
                profile_id: "profile-1".to_string(),
                tab_id: "tab-1".to_string(),
                execution_id: "execution-1".to_string(),
            })
            .expect("Raw artifact writer");
        (root, store, writer)
    }

    fn cancellation() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn explicit_format_keeps_sql_unchanged_and_finishes_a_text_artifact() {
        let sql = "SELECT 1 AS id, 'Ada' AS name FORMAT CSVWithNames";
        let executor =
            RecordingRawExecutor::chunks([Ok(b"id,name\n".to_vec()), Ok(b"1,Ada\n".to_vec())]);
        let (_root, store, writer) = artifact(1_024);
        let (_cancellation_sender, cancellation) = cancellation();

        let outcome = execute_raw_with(&executor, call(sql), writer, cancellation)
            .await
            .expect("Raw query succeeds");

        let calls = executor.calls();
        assert_eq!(calls[0].call.sql, sql);
        assert_eq!(calls[0].default_format, "TabSeparatedRaw");
        let RawQueryOutcome::Artifact {
            format,
            media_type,
            descriptor,
            ..
        } = outcome
        else {
            panic!("local Raw artifact expected");
        };
        assert_eq!(format, "CSVWithNames");
        assert_eq!(media_type, "text/csv");
        assert_eq!(descriptor.byte_length, 14);
        assert_eq!(descriptor.preview, "id,name\n1,Ada\n");
        assert!(!descriptor.preview_truncated);
        assert_eq!(store.entry_count_for_test(), 1);
    }

    #[tokio::test]
    async fn default_json_binary_and_invalid_utf8_formats_choose_safe_previews() {
        for (sql, bytes, expected_format, expected_media, expected_preview) in [
            (
                "SELECT 1",
                b"1\n".as_slice(),
                "TabSeparatedRaw",
                "text/tab-separated-values",
                "1\n",
            ),
            (
                "SELECT 1 FORMAT JSONEachRow",
                b"{\"id\":1}\n".as_slice(),
                "JSONEachRow",
                "application/json",
                "{\"id\":1}\n",
            ),
            (
                "SELECT 1 FORMAT ArrowStream",
                &[0x00, 0xff, 0x10],
                "ArrowStream",
                "application/vnd.apache.arrow.stream",
                "[hex] 00 ff 10",
            ),
            (
                "SELECT 1 FORMAT CSV",
                &[0xf0, 0x28, 0x8c, 0x28],
                "CSV",
                "text/csv",
                "[hex] f0 28 8c 28",
            ),
        ] {
            let executor = RecordingRawExecutor::chunks([Ok(bytes.to_vec())]);
            let (_root, _store, writer) = artifact(1_024);
            let (_cancellation_sender, cancellation) = cancellation();
            let outcome = execute_raw_with(&executor, call(sql), writer, cancellation)
                .await
                .expect("Raw format succeeds");
            let RawQueryOutcome::Artifact {
                format,
                media_type,
                descriptor,
                ..
            } = outcome
            else {
                panic!("local Raw artifact expected");
            };
            assert_eq!(format, expected_format, "{sql}");
            assert_eq!(media_type, expected_media, "{sql}");
            assert_eq!(descriptor.preview, expected_preview, "{sql}");
        }
    }

    #[tokio::test]
    async fn response_summary_is_returned_with_the_artifact() {
        let summary = SqlExecutionSummary {
            read_rows: Some(10),
            result_bytes: Some(4),
            source: SqlSummarySource::ResponseHeader,
            completeness: SqlSummaryCompleteness::Unknown,
            ..SqlExecutionSummary::default()
        };
        let executor =
            RecordingRawExecutor::with_summary([Ok(b"1\n".to_vec())], Some(summary.clone()));
        let (_root, _store, writer) = artifact(1_024);
        let (_cancellation_sender, cancellation) = cancellation();

        let outcome = execute_raw_with(&executor, call("SELECT 1"), writer, cancellation)
            .await
            .expect("Raw query succeeds");
        let RawQueryOutcome::Artifact {
            summary: actual, ..
        } = outcome
        else {
            panic!("local Raw artifact expected");
        };
        let actual = actual.expect("response summary");
        assert_eq!(actual.read_rows, summary.read_rows);
        assert_eq!(actual.result_bytes, summary.result_bytes);
        assert_eq!(actual.source, summary.source);
        assert_eq!(actual.completeness, summary.completeness);
    }

    #[tokio::test]
    async fn zero_byte_into_outfile_returns_server_outfile_without_local_artifact() {
        let executor = RecordingRawExecutor::chunks([]);
        let (_root, store, writer) = artifact(1_024);
        let (_cancellation_sender, cancellation) = cancellation();

        let outcome = execute_raw_with(
            &executor,
            call("SELECT 1 INTO OUTFILE 'server.csv' FORMAT CSV"),
            writer,
            cancellation,
        )
        .await
        .expect("server outfile succeeds");

        assert!(matches!(outcome, RawQueryOutcome::ServerOutfile { .. }));
        assert_eq!(store.entry_count_for_test(), 0);
    }

    enum RawFailure {
        Canceled,
        OverLimit,
        Transport,
        OwnerReleased,
    }

    async fn assert_partial_removed(failure: RawFailure) {
        let (executor, max_bytes) = match failure {
            RawFailure::Canceled | RawFailure::OwnerReleased => {
                (RecordingRawExecutor::chunks([Ok(b"data".to_vec())]), 64)
            }
            RawFailure::OverLimit => (RecordingRawExecutor::chunks([Ok(b"12345".to_vec())]), 4),
            RawFailure::Transport => (
                RecordingRawExecutor::chunks([Err(ClickHouseError::TimedOut)]),
                64,
            ),
        };
        let (_root, store, writer) = artifact(max_bytes);
        let mut cancellation_sender = None;
        let receiver = match failure {
            RawFailure::Canceled => {
                let (sender, receiver) = watch::channel(false);
                sender.send_replace(true);
                receiver
            }
            RawFailure::OwnerReleased => {
                store.release_tab("tab-1").expect("release Raw owner");
                let (sender, receiver) = cancellation();
                cancellation_sender = Some(sender);
                receiver
            }
            RawFailure::OverLimit | RawFailure::Transport => {
                let (sender, receiver) = cancellation();
                cancellation_sender = Some(sender);
                receiver
            }
        };

        let error = match execute_raw_with(&executor, call("SELECT 1"), writer, receiver).await {
            Ok(_) => panic!("Raw failure expected"),
            Err(error) => error,
        };
        match failure {
            RawFailure::Canceled | RawFailure::OwnerReleased => {
                assert_eq!(error.code, ErrorCode::OperationCanceled)
            }
            RawFailure::OverLimit => assert_eq!(error.code, ErrorCode::ValidationFailed),
            RawFailure::Transport => assert_eq!(error.code, ErrorCode::NetworkTimeout),
        }
        drop(cancellation_sender);
        assert_eq!(store.entry_count_for_test(), 0);
    }

    #[tokio::test]
    async fn cancellation_limit_transport_error_and_external_cleanup_remove_partial_artifacts() {
        assert_partial_removed(RawFailure::Canceled).await;
        assert_partial_removed(RawFailure::OverLimit).await;
        assert_partial_removed(RawFailure::Transport).await;
        assert_partial_removed(RawFailure::OwnerReleased).await;
    }
}
