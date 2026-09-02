import type { RuntimeMigration } from "./runtime-migration-manager";

export const RUNTIME_MIGRATIONS: RuntimeMigration[] = [
  {
    id: "0001_init_runtime_schema",
    description: "Create initial AI Runtime schema",
    sql: `
      CREATE TABLE runtime_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        status_json TEXT NOT NULL,
        parent_id TEXT,
        summary_json TEXT,
        share_json TEXT,
        time_json TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE TABLE runtime_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        parent_message_id TEXT,
        assistant_message_id TEXT,
        mode TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        usage_json TEXT,
        cost_json TEXT,
        finish TEXT,
        error_json TEXT,
        time_json TEXT NOT NULL,
        limits_json TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent TEXT,
        run_id TEXT,
        parent_id TEXT,
        provider_id TEXT,
        model_id TEXT,
        mode TEXT,
        scope TEXT,
        system TEXT,
        tools_json TEXT,
        summary_json TEXT,
        status_json TEXT,
        usage_json TEXT,
        cost_json TEXT,
        finish TEXT,
        error_json TEXT,
        time_json TEXT NOT NULL,
        metadata_json TEXT,
        message_json TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_message_parts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        type TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        time_json TEXT,
        metadata_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_tool_calls (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        part_id TEXT,
        tool_name TEXT NOT NULL,
        state TEXT NOT NULL,
        input_json TEXT NOT NULL,
        permission_id TEXT,
        result_json TEXT,
        error_json TEXT,
        time_json TEXT NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_permissions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tool_call_id TEXT,
        type TEXT NOT NULL,
        pattern_json TEXT,
        title TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        time_json TEXT NOT NULL,
        decision_json TEXT,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
      );

      CREATE TABLE runtime_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        conversation_id TEXT,
        run_id TEXT,
        payload_json TEXT NOT NULL,
        time INTEGER NOT NULL
      );

      CREATE TABLE runtime_traces (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        time INTEGER NOT NULL
      );

      CREATE INDEX idx_runtime_runs_conversation
        ON runtime_runs(conversation_id, time_json);

      CREATE INDEX idx_runtime_messages_conversation
        ON runtime_messages(conversation_id, time_json);

      CREATE INDEX idx_runtime_parts_message
        ON runtime_message_parts(message_id, sort_index);

      CREATE INDEX idx_runtime_tool_calls_run
        ON runtime_tool_calls(run_id, time_json);

      CREATE INDEX idx_runtime_permissions_run
        ON runtime_permissions(run_id, time_json);

      CREATE INDEX idx_runtime_events_conversation_time
        ON runtime_events(conversation_id, time);

      CREATE INDEX idx_runtime_traces_run_time
        ON runtime_traces(run_id, time);
    `,
  },
  {
    id: "0002_runtime_agent_mode_policy",
    description: "Rename Runtime mode/profile columns to agent mode and add policy snapshots",
    sql: `
      ALTER TABLE runtime_runs
        ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'ask';

      UPDATE runtime_runs
      SET agent_mode = CASE
        WHEN mode IN ('ask', 'agent') THEN mode
        WHEN profile_id IN ('ask', 'agent') THEN profile_id
        ELSE 'ask'
      END;

      UPDATE runtime_runs
      SET input_json = json_set(
        json_remove(input_json, '$.system', '$.tools'),
        '$.prompt',
        json_object(
          'version', 'legacy-migration',
          'blockIds', json_array(),
          'warnings', json_array('migrated from pre-agent-definition runtime record')
        ),
        '$.tools',
        json_object(
          'enabled', json_array(),
          'active', json_array(),
          'warnings', json_array()
        )
      )
      WHERE json_type(input_json, '$.prompt') IS NULL;

      ALTER TABLE runtime_runs DROP COLUMN profile_id;
      ALTER TABLE runtime_runs DROP COLUMN mode;

      ALTER TABLE runtime_messages
        ADD COLUMN agent_mode TEXT;

      UPDATE runtime_messages
      SET agent_mode = CASE
        WHEN role = 'user' AND agent IN ('ask', 'agent') THEN agent
        WHEN role = 'assistant' AND mode IN ('ask', 'agent') THEN mode
        ELSE NULL
      END;

      UPDATE runtime_messages
      SET message_json = CASE
        WHEN role = 'user' THEN json_set(
          json_remove(message_json, '$.agent', '$.system', '$.tools'),
          '$.agentMode',
          CASE
            WHEN json_extract(message_json, '$.agent') IN ('ask', 'agent')
              THEN json_extract(message_json, '$.agent')
            WHEN agent_mode IN ('ask', 'agent') THEN agent_mode
            ELSE 'ask'
          END
        )
        WHEN role = 'assistant' THEN json_set(
          json_remove(message_json, '$.mode'),
          '$.agentMode',
          CASE
            WHEN json_extract(message_json, '$.mode') IN ('ask', 'agent')
              THEN json_extract(message_json, '$.mode')
            WHEN agent_mode IN ('ask', 'agent') THEN agent_mode
            ELSE 'ask'
          END
        )
        ELSE message_json
      END;

      ALTER TABLE runtime_messages DROP COLUMN agent;
      ALTER TABLE runtime_messages DROP COLUMN mode;
      ALTER TABLE runtime_messages DROP COLUMN system;
      ALTER TABLE runtime_messages DROP COLUMN tools_json;
    `,
  },
  {
    id: "0003_runtime_interrupted_status",
    description: "Migrate runtime cancelled placeholder states to interrupted",
    sql: `
      UPDATE runtime_runs
      SET
        status = CASE WHEN status = 'cancelled' THEN 'interrupted' ELSE status END,
        finish = CASE WHEN finish = 'cancelled' THEN 'interrupted' ELSE finish END,
        metadata_json = json_set(
          COALESCE(metadata_json, '{}'),
          '$.interrupt.reason',
          COALESCE(json_extract(metadata_json, '$.interrupt.reason'), 'unknown'),
          '$.interrupt.interruptedAt',
          COALESCE(json_extract(metadata_json, '$.interrupt.interruptedAt'), json_extract(time_json, '$.completed'))
        )
      WHERE status = 'cancelled' OR finish = 'cancelled';

      UPDATE runtime_messages
      SET
        status_json = CASE
          WHEN json_extract(status_json, '$.type') = 'incomplete'
            AND json_extract(status_json, '$.reason') = 'cancelled'
            THEN json_set(status_json, '$.reason', 'interrupted')
          ELSE status_json
        END,
        finish = CASE WHEN finish = 'cancelled' THEN 'interrupted' ELSE finish END,
        message_json = CASE
          WHEN json_extract(message_json, '$.finish') = 'cancelled' THEN json_set(
            CASE
              WHEN json_extract(message_json, '$.status.type') = 'incomplete'
                AND json_extract(message_json, '$.status.reason') = 'cancelled'
                THEN json_set(message_json, '$.status.reason', 'interrupted')
              ELSE message_json
            END,
            '$.finish',
            'interrupted'
          )
          ELSE CASE
            WHEN json_extract(message_json, '$.status.type') = 'incomplete'
              AND json_extract(message_json, '$.status.reason') = 'cancelled'
              THEN json_set(message_json, '$.status.reason', 'interrupted')
            ELSE message_json
          END
        END
      WHERE finish = 'cancelled'
        OR json_extract(status_json, '$.reason') = 'cancelled'
        OR json_extract(message_json, '$.status.reason') = 'cancelled'
        OR json_extract(message_json, '$.finish') = 'cancelled';

      UPDATE runtime_message_parts
      SET payload_json = json_set(payload_json, '$.state.status', 'interrupted')
      WHERE type = 'tool'
        AND json_extract(payload_json, '$.state.status') = 'cancelled';

      UPDATE runtime_tool_calls
      SET state = 'interrupted'
      WHERE state = 'cancelled';
    `,
  },
  {
    id: "0004_runtime_run_tool_snapshot",
    description: "Replace legacy Tool policy snapshots with immutable per-Run snapshots",
    sql: `
      UPDATE runtime_runs
      SET input_json = json_set(
        input_json,
        '$.tools',
        json_object(
          'snapshotId', 'tool_snapshot_migrated_' || id,
          'runId', id,
          'createdAt', COALESCE(
            strftime(
              '%Y-%m-%dT%H:%M:%fZ',
              json_extract(time_json, '$.created') / 1000.0,
              'unixepoch'
            ),
            '1970-01-01T00:00:00.000Z'
          ),
          'agentMode', CASE WHEN agent_mode = 'agent' THEN 'agent' ELSE 'ask' END,
          'executionCeiling', CASE
            WHEN agent_mode = 'agent' THEN json_object(
              'maxRiskLevel', 'critical',
              'allowedSideEffects', json_array(
                'none', 'external_network', 'runtime_state', 'workbench_state',
                'business_read', 'business_write', 'destructive'
              ),
              'allowIrreversible', json('true')
            )
            ELSE json_object(
              'maxRiskLevel', 'low',
              'allowedSideEffects', json_array(
                'none', 'external_network', 'business_read'
              ),
              'allowIrreversible', json('false')
            )
          END,
          'activeTools', json_array()
        )
      )
      WHERE json_type(input_json, '$.tools.snapshotId') IS NULL;
    `,
  },
  {
    id: "0005_runtime_tool_permission_state",
    description: "Replace legacy permissions with Runtime-owned Tool Permission state",
    sql: `
      CREATE TABLE runtime_permissions_v2 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        title TEXT NOT NULL,
        input_summary TEXT,
        risk_json TEXT NOT NULL,
        adapter_json TEXT,
        decision_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES runtime_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runtime_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE
      );

      INSERT INTO runtime_permissions_v2 (
        id, conversation_id, run_id, message_id, tool_call_id, status, tool_id,
        title, input_summary, risk_json, adapter_json, decision_json, created_at
      )
      SELECT
        id,
        conversation_id,
        run_id,
        message_id,
        CASE
          WHEN legacy.tool_call_id IS NULL THEN 'tool_legacy_' || legacy.id
          WHEN legacy.id = (
            SELECT MIN(other.id)
            FROM runtime_permissions AS other
            WHERE other.tool_call_id = legacy.tool_call_id
          ) THEN legacy.tool_call_id
          ELSE 'tool_legacy_' || legacy.id
        END,
        CASE json_extract(decision_json, '$.response')
          WHEN 'allow' THEN 'approved'
          WHEN 'allow_once' THEN 'approved'
          WHEN 'deny' THEN 'denied'
          WHEN 'deny_once' THEN 'denied'
          ELSE 'pending'
        END,
        COALESCE(json_extract(metadata_json, '$.toolName'), 'legacy.unknown'),
        title,
        json_extract(metadata_json, '$.inputSummary'),
        json_object(
          'level',
          CASE json_extract(metadata_json, '$.risk')
            WHEN 'low' THEN 'low'
            WHEN 'medium' THEN 'medium'
            WHEN 'high' THEN 'high'
            ELSE 'critical'
          END,
          'reversible',
          json('false'),
          'sideEffects',
          CASE json_extract(metadata_json, '$.sideEffect')
            WHEN 'none' THEN json_array('none')
            WHEN 'external_network' THEN json_array('external_network')
            WHEN 'business_read' THEN json_array('business_read')
            WHEN 'business_write' THEN json_array('business_write')
            WHEN 'destructive' THEN json_array('destructive')
            ELSE json_array()
          END
        ),
        NULL,
        CASE
          WHEN json_extract(decision_json, '$.response') IN (
            'allow', 'allow_once', 'deny', 'deny_once'
          ) THEN json_patch(
            json_object(
              'source',
              CASE json_extract(decision_json, '$.source')
                WHEN 'user' THEN 'user'
                ELSE 'system'
              END,
              'decidedAt',
              COALESCE(
                json_extract(decision_json, '$.time'),
                json_extract(time_json, '$.decided'),
                json_extract(time_json, '$.created'),
                0
              )
            ),
            CASE
              WHEN json_extract(decision_json, '$.reason') IS NULL THEN json('{}')
              ELSE json_object('reason', json_extract(decision_json, '$.reason'))
            END
          )
          ELSE NULL
        END,
        COALESCE(json_extract(time_json, '$.created'), 0)
      FROM runtime_permissions AS legacy;

      DROP TABLE runtime_permissions;
      ALTER TABLE runtime_permissions_v2 RENAME TO runtime_permissions;

      CREATE INDEX idx_runtime_permissions_run
        ON runtime_permissions(run_id, created_at);

      CREATE INDEX idx_runtime_permissions_pending_run
        ON runtime_permissions(run_id, status, created_at);

      CREATE UNIQUE INDEX idx_runtime_permissions_tool_call
        ON runtime_permissions(tool_call_id);
    `,
  },
  {
    id: "0006_runtime_tool_permission_confirmation",
    description:
      "Persist confirmation requirements and user-facing Permission presentation",
    sql: `
      ALTER TABLE runtime_permissions
        ADD COLUMN confirmation_json TEXT;

      ALTER TABLE runtime_permissions
        ADD COLUMN presentation_json TEXT;

      UPDATE runtime_permissions
      SET confirmation_json = CASE
        WHEN json_extract(risk_json, '$.level') = 'critical'
          THEN json_object(
            'level', 'strong',
            'prompt', '确认执行 ' || title || '（' || tool_id || '）'
          )
        ELSE json_object('level', 'standard')
      END
      WHERE confirmation_json IS NULL;
    `,
  },
  {
    id: "0007_runtime_chat_attachments",
    description: "Create Runtime-owned upload, blob, attachment, and message reference storage",
    sql: `
      CREATE TABLE runtime_blobs (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        storage_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('available', 'deleting', 'corrupt')),
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      );

      CREATE TABLE runtime_attachments (
        id TEXT PRIMARY KEY,
        blob_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        declared_media_type TEXT,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        state TEXT NOT NULL CHECK (state IN ('ready', 'corrupt', 'deleting')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        gc_after INTEGER,
        FOREIGN KEY (blob_id) REFERENCES runtime_blobs(id) ON DELETE RESTRICT
      );

      CREATE TABLE runtime_attachment_uploads (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        declared_media_type TEXT,
        declared_byte_length INTEGER NOT NULL CHECK (declared_byte_length >= 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
        attachment_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (attachment_id) REFERENCES runtime_attachments(id) ON DELETE CASCADE,
        CHECK (
          (state = 'pending' AND attachment_id IS NULL) OR
          (state = 'completed' AND attachment_id IS NOT NULL)
        )
      );

      CREATE TABLE runtime_message_attachments (
        part_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        sort_index INTEGER NOT NULL,
        FOREIGN KEY (part_id) REFERENCES runtime_message_parts(id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES runtime_messages(id) ON DELETE CASCADE,
        FOREIGN KEY (attachment_id) REFERENCES runtime_attachments(id) ON DELETE RESTRICT,
        UNIQUE (message_id, sort_index)
      );

      CREATE INDEX idx_runtime_attachments_blob
        ON runtime_attachments(blob_id);
      CREATE INDEX idx_runtime_attachments_state_gc
        ON runtime_attachments(state, gc_after);
      CREATE INDEX idx_runtime_attachment_uploads_state_expiry
        ON runtime_attachment_uploads(state, expires_at);
      CREATE INDEX idx_runtime_message_attachments_attachment
        ON runtime_message_attachments(attachment_id);
      CREATE INDEX idx_runtime_blobs_state
        ON runtime_blobs(state);
    `,
  },
];
