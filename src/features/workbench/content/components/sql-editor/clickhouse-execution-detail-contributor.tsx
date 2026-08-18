import type { FC } from "react";

import type { JsonSafeInteger } from "@/types/ipc";

import type {
    SqlExecutionDetailContext,
    SqlExecutionDetailContributor,
} from "./execution-detail-contributor-registry";

export interface ClickHouseExecutionDetailModel {
    progressLabel: string;
    summarySource: string | null;
    summaryCompleteness: string | null;
    memoryUsage: string | null;
    warnings: string[];
}

function formatJsonSafeBytes(
    value: JsonSafeInteger | undefined,
): string | null {
    if (value === undefined) return null;
    return `${BigInt(String(value)).toLocaleString("en-US")} B`;
}

export function buildClickHouseExecutionDetailModel(
    context: SqlExecutionDetailContext,
): ClickHouseExecutionDetailModel {
    return {
        progressLabel: context.snapshot.progressAvailable ? "可用" : "不可用",
        summarySource: context.snapshot.summary?.source ?? null,
        summaryCompleteness:
            context.snapshot.summary?.completeness ?? null,
        memoryUsage: formatJsonSafeBytes(
            context.snapshot.summary?.memoryUsage,
        ),
        warnings: context.snapshot.observationWarnings ?? [],
    };
}

const ClickHouseExecutionObservation: FC<{
    model: ClickHouseExecutionDetailModel;
}> = ({ model }) => (
    <section className="mt-5 flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">
            ClickHouse 观察信息
        </h3>
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">实时进度</dt>
            <dd className="break-all text-foreground">
                {model.progressLabel}
            </dd>
            {model.summarySource ? (
                <>
                    <dt className="text-muted-foreground">摘要来源</dt>
                    <dd className="break-all text-foreground">
                        {model.summarySource}
                    </dd>
                </>
            ) : null}
            {model.summaryCompleteness ? (
                <>
                    <dt className="text-muted-foreground">摘要完整度</dt>
                    <dd className="break-all text-foreground">
                        {model.summaryCompleteness}
                    </dd>
                </>
            ) : null}
            {model.memoryUsage ? (
                <>
                    <dt className="text-muted-foreground">内存用量</dt>
                    <dd className="break-all text-foreground">
                        {model.memoryUsage}
                    </dd>
                </>
            ) : null}
        </dl>
        {model.warnings.length > 0 ? (
            <div className="flex flex-col gap-1 text-sm">
                <h4 className="font-medium text-foreground">观察降级</h4>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {model.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                    ))}
                </ul>
            </div>
        ) : null}
    </section>
);

export const clickhouseExecutionDetailContributor: SqlExecutionDetailContributor = {
    id: "clickhouse-execution-observation",
    supports: (context) =>
        context.driverName.trim().toLowerCase() === "clickhouse",
    render: (context) => (
        <ClickHouseExecutionObservation
            model={buildClickHouseExecutionDetailModel(context)}
        />
    ),
};
