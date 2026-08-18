export type ToolExecutionOutcome = "not_started" | "no_effect" | "unknown";

export interface RuntimeToolError {
  code: string;
  message: string;
  retryable: boolean;
  outcome: ToolExecutionOutcome;
  details?: Record<string, unknown>;
}

export interface ToolExecutionOutput<TData> {
  summary: string;
  data: TData;
  warnings?: string[];
}

export type RuntimeToolResult<TData> =
  | ({ ok: true } & ToolExecutionOutput<TData>)
  | { ok: false; error: RuntimeToolError };
