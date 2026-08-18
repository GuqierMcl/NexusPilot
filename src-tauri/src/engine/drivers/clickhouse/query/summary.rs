use crate::engine::types::{SqlExecutionSummary, SqlSummaryCompleteness, SqlSummarySource};

#[derive(Default)]
struct SummaryFields {
    read_rows: Option<u64>,
    read_bytes: Option<u64>,
    written_rows: Option<u64>,
    written_bytes: Option<u64>,
    total_rows_to_read: Option<u64>,
    result_rows: Option<u64>,
    result_bytes: Option<u64>,
    elapsed_ns: Option<u64>,
    memory_usage: Option<u64>,
}

pub(super) fn from_clickhouse(summary: &clickhouse::QuerySummary) -> SqlExecutionSummary {
    from_fields(SummaryFields {
        read_rows: summary.read_rows(),
        read_bytes: summary.read_bytes(),
        written_rows: summary.written_rows(),
        written_bytes: summary.written_bytes(),
        total_rows_to_read: summary.total_rows_to_read(),
        result_rows: summary.result_rows(),
        result_bytes: summary.result_bytes(),
        elapsed_ns: summary.elapsed_ns(),
        memory_usage: summary.memory_usage(),
    })
}

fn from_fields(fields: SummaryFields) -> SqlExecutionSummary {
    SqlExecutionSummary {
        read_rows: fields.read_rows,
        read_bytes: fields.read_bytes,
        written_rows: fields.written_rows,
        written_bytes: fields.written_bytes,
        total_rows_to_read: fields.total_rows_to_read,
        result_rows: fields.result_rows,
        result_bytes: fields.result_bytes,
        elapsed_ns: fields.elapsed_ns,
        memory_usage: fields.memory_usage,
        source: SqlSummarySource::ResponseHeader,
        completeness: SqlSummaryCompleteness::Unknown,
    }
}

pub(super) fn merge_summary(
    live: Option<SqlExecutionSummary>,
    response: Option<SqlExecutionSummary>,
) -> Option<SqlExecutionSummary> {
    match (live, response) {
        (None, None) => None,
        (Some(summary), None) | (None, Some(summary)) => Some(summary),
        (Some(live), Some(response)) => Some(SqlExecutionSummary {
            read_rows: max_optional(live.read_rows, response.read_rows),
            read_bytes: max_optional(live.read_bytes, response.read_bytes),
            written_rows: max_optional(live.written_rows, response.written_rows),
            written_bytes: max_optional(live.written_bytes, response.written_bytes),
            total_rows_to_read: max_optional(live.total_rows_to_read, response.total_rows_to_read),
            result_rows: response.result_rows.or(live.result_rows),
            result_bytes: response.result_bytes.or(live.result_bytes),
            elapsed_ns: max_optional(live.elapsed_ns, response.elapsed_ns),
            memory_usage: live.memory_usage.or(response.memory_usage),
            source: SqlSummarySource::Merged,
            completeness: merge_completeness(live.completeness, response.completeness),
        }),
    }
}

fn max_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn merge_completeness(
    left: SqlSummaryCompleteness,
    right: SqlSummaryCompleteness,
) -> SqlSummaryCompleteness {
    match (left, right) {
        (SqlSummaryCompleteness::Partial, _) | (_, SqlSummaryCompleteness::Partial) => {
            SqlSummaryCompleteness::Partial
        }
        (SqlSummaryCompleteness::Final, SqlSummaryCompleteness::Final) => {
            SqlSummaryCompleteness::Final
        }
        _ => SqlSummaryCompleteness::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_response_header_fields_without_inventing_missing_metrics() {
        let mapped = from_fields(SummaryFields {
            read_rows: Some(9_007_199_254_740_992),
            result_rows: Some(2),
            ..SummaryFields::default()
        });

        assert_eq!(mapped.read_rows, Some(9_007_199_254_740_992));
        assert_eq!(mapped.result_rows, Some(2));
        assert_eq!(mapped.written_rows, None);
        assert_eq!(mapped.source, SqlSummarySource::ResponseHeader);
        assert_eq!(mapped.completeness, SqlSummaryCompleteness::Unknown);
    }

    #[test]
    fn merge_keeps_known_fields_and_uses_monotonic_counters() {
        let live = SqlExecutionSummary {
            read_rows: Some(100),
            read_bytes: Some(2_048),
            memory_usage: Some(4_096),
            source: SqlSummarySource::LivePoll,
            completeness: SqlSummaryCompleteness::Partial,
            ..SqlExecutionSummary::default()
        };
        let header = SqlExecutionSummary {
            read_rows: Some(120),
            result_rows: Some(10),
            result_bytes: Some(512),
            source: SqlSummarySource::ResponseHeader,
            completeness: SqlSummaryCompleteness::Unknown,
            ..SqlExecutionSummary::default()
        };

        let merged = merge_summary(Some(live), Some(header)).unwrap();

        assert_eq!(merged.read_rows, Some(120));
        assert_eq!(merged.read_bytes, Some(2_048));
        assert_eq!(merged.result_rows, Some(10));
        assert_eq!(merged.memory_usage, Some(4_096));
        assert_eq!(merged.source, SqlSummarySource::Merged);
        assert_eq!(merged.completeness, SqlSummaryCompleteness::Partial);
    }

    #[test]
    fn merge_never_turns_missing_metrics_into_zero_or_unknown_into_final() {
        let merged = merge_summary(
            Some(SqlExecutionSummary {
                read_rows: Some(1),
                source: SqlSummarySource::LivePoll,
                completeness: SqlSummaryCompleteness::Partial,
                ..SqlExecutionSummary::default()
            }),
            Some(SqlExecutionSummary {
                result_rows: Some(2),
                source: SqlSummarySource::ResponseHeader,
                completeness: SqlSummaryCompleteness::Unknown,
                ..SqlExecutionSummary::default()
            }),
        )
        .unwrap();

        assert_eq!(merged.written_rows, None);
        assert_ne!(merged.completeness, SqlSummaryCompleteness::Final);
    }
}
