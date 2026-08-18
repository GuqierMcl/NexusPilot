use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use clickhouse::error::Error as ClickHouseError;
use clickhouse::Client;
use serde::Deserialize;
use tokio::sync::watch;

use super::policy::ExecutionPolicy;
use crate::engine::sql_execution::SqlExecutionControl;
use crate::engine::types::{SqlExecutionSummary, SqlSummaryCompleteness, SqlSummarySource};

const PROGRESS_SQL: &str = r#"
SELECT
    read_rows,
    read_bytes,
    written_rows,
    written_bytes,
    toUInt64(greatest(elapsed, 0) * 1000000000) AS elapsed_ns,
    toUInt64(greatest(memory_usage, 0)) AS memory_usage,
    total_rows_approx AS total_rows_to_read
FROM system.processes
WHERE query_id = ?
LIMIT 1
"#;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(750);
const PROGRESS_TIMEOUT_MS: u64 = 5_000;

#[derive(Debug, Clone, clickhouse::Row, Deserialize)]
struct ProcessProgressRow {
    read_rows: u64,
    read_bytes: u64,
    written_rows: u64,
    written_bytes: u64,
    elapsed_ns: u64,
    memory_usage: u64,
    total_rows_to_read: u64,
}

impl ProcessProgressRow {
    fn into_summary(self) -> SqlExecutionSummary {
        SqlExecutionSummary {
            read_rows: Some(self.read_rows),
            read_bytes: Some(self.read_bytes),
            written_rows: Some(self.written_rows),
            written_bytes: Some(self.written_bytes),
            total_rows_to_read: Some(self.total_rows_to_read),
            elapsed_ns: Some(self.elapsed_ns),
            memory_usage: Some(self.memory_usage),
            source: SqlSummarySource::LivePoll,
            completeness: SqlSummaryCompleteness::Partial,
            ..SqlExecutionSummary::default()
        }
    }
}

#[derive(Default)]
pub(super) struct ProgressObservation {
    pub latest: Option<SqlExecutionSummary>,
    pub available: bool,
}

#[async_trait]
trait ProgressSource: Send + Sync {
    async fn fetch(
        &self,
        target_query_id: &str,
        control_query_id: &str,
    ) -> Result<Option<ProcessProgressRow>, ClickHouseError>;
}

struct ClientProgressSource {
    client: Client,
}

#[async_trait]
impl ProgressSource for ClientProgressSource {
    async fn fetch(
        &self,
        target_query_id: &str,
        control_query_id: &str,
    ) -> Result<Option<ProcessProgressRow>, ClickHouseError> {
        let query = ExecutionPolicy::Control.apply(
            self.client
                .query(PROGRESS_SQL)
                .bind(target_query_id)
                .with_setting("query_id", control_query_id),
            Some(PROGRESS_TIMEOUT_MS),
        );
        tokio::time::timeout(
            Duration::from_millis(PROGRESS_TIMEOUT_MS),
            query.fetch_optional::<ProcessProgressRow>(),
        )
        .await
        .map_err(|_| ClickHouseError::TimedOut)?
    }
}

pub(super) async fn poll_progress(
    client: Client,
    target_query_id: String,
    control: SqlExecutionControl,
    stop: watch::Receiver<bool>,
) -> ProgressObservation {
    poll_progress_with(
        Arc::new(ClientProgressSource { client }),
        target_query_id,
        control,
        stop,
        PROGRESS_INTERVAL,
    )
    .await
}

async fn poll_progress_with<S: ProgressSource + 'static>(
    source: Arc<S>,
    target_query_id: String,
    control: SqlExecutionControl,
    mut stop: watch::Receiver<bool>,
    interval: Duration,
) -> ProgressObservation {
    let mut observation = ProgressObservation::default();
    loop {
        if *stop.borrow() {
            return observation;
        }
        let control_query_id = uuid::Uuid::new_v4().to_string();
        let response = tokio::select! {
            biased;
            changed = stop.changed() => {
                let _ = changed;
                return observation;
            }
            response = source.fetch(&target_query_id, &control_query_id) => response,
        };
        match response {
            Ok(Some(row)) => {
                let summary = row.into_summary();
                observation.latest = Some(summary.clone());
                observation.available = true;
                control.publish_summary(summary, true);
            }
            Ok(None) => {}
            Err(error) => {
                control.publish_warning(super::super::error::progress_warning(&error).to_string());
                return observation;
            }
        }

        tokio::select! {
            biased;
            changed = stop.changed() => {
                let _ = changed;
                return observation;
            }
            _ = tokio::time::sleep(interval) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use clickhouse::error::Error as ClickHouseError;
    use tokio::sync::watch;

    use super::*;
    use crate::engine::sql_execution::{SqlExecutionControl, SqlExecutionObserver};
    use crate::engine::types::SqlExecutionSummary;

    struct RecordingProgressSource {
        responses: Mutex<VecDeque<Result<Option<ProcessProgressRow>, ClickHouseError>>>,
        calls: AtomicUsize,
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
    }

    impl RecordingProgressSource {
        fn responses(responses: Vec<Result<Option<ProcessProgressRow>, ClickHouseError>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: AtomicUsize::new(0),
                in_flight: AtomicUsize::new(0),
                max_in_flight: AtomicUsize::new(0),
            }
        }

        fn error(error: ClickHouseError) -> Self {
            Self::responses(vec![Err(error)])
        }

        async fn wait_for_calls(&self, expected: usize) {
            tokio::time::timeout(Duration::from_secs(2), async {
                while self.calls.load(Ordering::SeqCst) < expected {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("progress calls reached expected count");
        }

        fn max_in_flight(&self) -> usize {
            self.max_in_flight.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ProgressSource for RecordingProgressSource {
        async fn fetch(
            &self,
            _target_query_id: &str,
            _control_query_id: &str,
        ) -> Result<Option<ProcessProgressRow>, ClickHouseError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_in_flight.fetch_max(current, Ordering::SeqCst);
            tokio::task::yield_now().await;
            let response = self
                .responses
                .lock()
                .expect("responses lock")
                .pop_front()
                .unwrap_or(Ok(None));
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            response
        }
    }

    #[derive(Default)]
    struct RecordingObserver {
        summaries: Mutex<Vec<(SqlExecutionSummary, bool)>>,
        warnings: Mutex<Vec<String>>,
    }

    impl SqlExecutionObserver for RecordingObserver {
        fn publish_summary(&self, summary: SqlExecutionSummary, available: bool) {
            self.summaries
                .lock()
                .expect("summaries lock")
                .push((summary, available));
        }

        fn publish_warning(&self, message: String) {
            self.warnings.lock().expect("warnings lock").push(message);
        }
    }

    struct RecordingControl {
        control: SqlExecutionControl,
        _cancel: watch::Sender<bool>,
        observer: Arc<RecordingObserver>,
    }

    fn recording_control() -> RecordingControl {
        let (cancel, receiver) = watch::channel(false);
        let observer = Arc::new(RecordingObserver::default());
        RecordingControl {
            control: SqlExecutionControl::new(receiver, observer.clone()),
            _cancel: cancel,
            observer,
        }
    }

    fn progress_row(read_rows: u64, read_bytes: u64, memory_usage: u64) -> ProcessProgressRow {
        ProcessProgressRow {
            read_rows,
            read_bytes,
            written_rows: 0,
            written_bytes: 0,
            elapsed_ns: read_rows * 1_000,
            memory_usage,
            total_rows_to_read: 100,
        }
    }

    #[tokio::test]
    async fn progress_polls_serially_and_publishes_partial_summary() {
        let source = Arc::new(RecordingProgressSource::responses(vec![
            Ok(Some(progress_row(10, 100, 1_024))),
            Ok(Some(progress_row(20, 200, 2_048))),
        ]));
        let fixture = recording_control();
        let (stop_tx, stop_rx) = watch::channel(false);

        let task_source = source.clone();
        let task_control = fixture.control.clone();
        let task = tokio::spawn(async move {
            poll_progress_with(
                task_source,
                "target-query".to_string(),
                task_control,
                stop_rx,
                Duration::from_millis(1),
            )
            .await
        });
        source.wait_for_calls(2).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while fixture
                .observer
                .summaries
                .lock()
                .expect("summaries lock")
                .len()
                < 2
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("two progress summaries were published");
        stop_tx.send_replace(true);
        let observation = task.await.unwrap();

        assert_eq!(source.max_in_flight(), 1);
        assert_eq!(observation.latest.unwrap().read_rows, Some(20));
        assert!(observation.available);
        assert!(fixture
            .observer
            .summaries
            .lock()
            .expect("summaries lock")
            .iter()
            .all(|(_, available)| *available));
    }

    #[tokio::test]
    async fn progress_permission_or_column_failure_degrades_without_main_failure() {
        for error in [
            ClickHouseError::BadResponse("Code: 497. ACCESS_DENIED".to_string()),
            ClickHouseError::BadResponse(
                "Code: 47. UNKNOWN_IDENTIFIER total_rows_approx".to_string(),
            ),
        ] {
            let source = Arc::new(RecordingProgressSource::error(error));
            let fixture = recording_control();
            let (_stop_tx, stop_rx) = watch::channel(false);

            let observation = poll_progress_with(
                source,
                "target-query".to_string(),
                fixture.control,
                stop_rx,
                Duration::from_millis(1),
            )
            .await;

            assert!(!observation.available);
            assert_eq!(
                fixture
                    .observer
                    .warnings
                    .lock()
                    .expect("warnings lock")
                    .len(),
                1,
            );
            assert!(fixture
                .observer
                .summaries
                .lock()
                .expect("summaries lock")
                .is_empty());
        }
    }

    #[tokio::test]
    async fn no_process_row_does_not_decide_query_terminal_state() {
        let source = Arc::new(RecordingProgressSource::responses(vec![Ok(None), Ok(None)]));
        let fixture = recording_control();
        let (stop_tx, stop_rx) = watch::channel(false);

        let task_source = source.clone();
        let task_control = fixture.control.clone();
        let task = tokio::spawn(async move {
            poll_progress_with(
                task_source,
                "target-query".to_string(),
                task_control,
                stop_rx,
                Duration::from_millis(1),
            )
            .await
        });
        source.wait_for_calls(2).await;
        stop_tx.send_replace(true);
        let observation = task.await.unwrap();

        assert!(observation.latest.is_none());
        assert!(!observation.available);
        assert!(fixture
            .observer
            .warnings
            .lock()
            .expect("warnings lock")
            .is_empty());
    }
}
