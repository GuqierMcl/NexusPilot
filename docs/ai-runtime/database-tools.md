# Database tool safety model

Status: **Current**

AI database tools are workbench capabilities exposed through the AI Runtime. They do not create independent database connections and do not accept arbitrary driver-specific command strings when a structured operation is available.

## Execution path

```text
Agent mode + model capabilities + Runtime settings
  -> immutable per-run Tool Snapshot
  -> Runtime Tool Core
  -> risk and permission decision
  -> optional prepared plan and user approval
  -> authenticated Backend Bridge
  -> Rust Gateway
  -> shared ConnectionRuntimeManager
```

Every layer may reject a call. Being present in a Tool Snapshot means only that the model may request the tool; it is not proof that the requested operation is authorized or safe.

## SQL rules

- Structured metadata and table operations are preferred over raw SQL.
- `sql.execute` accepts one statement only when the statement can be delimited and classified reliably.
- Read-only SQL may use the ordinary approval threshold configured for the run.
- Data-changing, schema-changing, privilege, transaction-control, administrative, or ambiguous SQL is elevated according to risk.
- A statement that cannot be classified safely is `critical` and requires strong confirmation.
- The exact SQL, selected connection, database/schema context, and relevant execution options are frozen for approval; approval cannot authorize a later mutated request.
- Execution uses the Rust connection runtime and preserves each driver's capability and session semantics.

## Key-value rules

- Structured tools represent operations such as scan, get, create, set, rename, set TTL, and delete; they do not accept an arbitrary Redis command.
- Mutations use a prepare/execute boundary with a short-lived, single-use plan.
- The prepared plan binds the target connection, key identity, operation, expected state fingerprint, and replacement value metadata.
- Execution fails closed when the target changed after preparation, the plan expired, or the plan was already consumed.
- Exact deletion and expiry that can remove data require strong confirmation.
- Temporary-key switching and compare-and-set checks are used where the driver can provide them, but the UI must not claim cross-command atomicity that the engine does not guarantee.

## Approval and continuation

- Runtime owns permission state and persists enough information to resume the same run.
- Standard approval presents the operation and its risk summary.
- Strong confirmation requires an explicit, operation-specific confirmation step for critical changes.
- Approval output resumes the original tool call in the same run; it does not create a new unrelated request.
- Denial, expiration, disconnect, stale prepared state, or mismatched continuation fails closed.

## Logging and secrets

Logs may include stable operation IDs, tool IDs, driver names, risk levels, durations, and sanitized error codes. They must not include passwords, access tokens, full connection strings, provider credentials, private keys, Recovery Keys, raw sensitive query results, or hidden prepared-plan fingerprints.

## References

- [Tool namespace and core](./tool-namespace.md)
- [Tool permission and continuation](./tool-permission.md)
- [Backend bridge](./backend-bridge.md)
- [Database runtime sessions](../architecture/database-runtime-session.md)
