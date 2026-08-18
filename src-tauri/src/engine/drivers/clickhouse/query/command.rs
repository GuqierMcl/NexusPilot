use clickhouse::Client;

use super::policy::ExecutionPolicy;
use crate::error::IpcResult;

pub(super) struct CommandQueryRequest<'a> {
    pub(super) sql: &'a str,
    pub(super) query_id: &'a str,
    pub(super) timeout_ms: Option<u64>,
}

pub(super) async fn execute(client: &Client, request: CommandQueryRequest<'_>) -> IpcResult<()> {
    let query = ExecutionPolicy::DirectGrid
        .apply_command(client.query(request.sql), request.timeout_ms)
        .with_setting("query_id", request.query_id);
    query.execute().await.map_err(|error| {
        super::super::error::classify_query_error(error, "execute managed command")
    })
}
