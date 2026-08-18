import { formatJsonSafeInteger } from "@/lib/json-safe-integer";
import type { QueryResult, SqlExecutionOutcome } from "@/types/ipc";

export type SqlExecutionOutcomePresentation =
    | {
          kind: "rows";
          result: QueryResult;
          emptyLabel: string;
      }
    | {
          kind: "command";
          headline: string;
          metricLabel: string | null;
          warning: string | null;
      }
    | {
          kind: "raw";
          outcome: Extract<SqlExecutionOutcome, { kind: "raw" }>;
      };

function rowsPresentation(
    result: QueryResult,
): SqlExecutionOutcomePresentation {
    const hasAffectedRows = result.affectedRows != null;
    return {
        kind: "rows",
        result,
        emptyLabel: hasAffectedRows
            ? `影响 ${result.affectedRows} 行`
            : "执行完成",
    };
}

export function buildSqlExecutionOutcomePresentation(
    outcome: SqlExecutionOutcome | null,
    legacyResult: QueryResult | null,
): SqlExecutionOutcomePresentation | null {
    if (outcome?.kind === "rows") {
        return rowsPresentation(outcome.result);
    }
    if (outcome?.kind === "command") {
        return {
            kind: "command",
            headline: outcome.completionMessage,
            metricLabel:
                outcome.summary?.writtenRows != null
                    ? `写入 ${formatJsonSafeInteger(outcome.summary.writtenRows)} 行`
                    : null,
            warning: outcome.mutationSubmitted
                ? "请求已提交；服务端 mutation 可能继续异步执行，请勿把提交成功理解为数据变更已完成。"
                : null,
        };
    }
    if (outcome?.kind === "raw") {
        return {
            kind: "raw",
            outcome,
        };
    }
    return legacyResult ? rowsPresentation(legacyResult) : null;
}
