import { Fragment, type FC, type ReactNode } from "react";

import {
    Drawer,
    DrawerContent,
    DrawerDescription,
    DrawerHeader,
    DrawerTitle,
} from "@/components/ui/drawer";
import type {
    SqlEditorExecutionOptionsState,
    SqlExecutionTimelineEntry,
} from "@/store";
import type {
    JsonSafeInteger,
    SqlExecutionSnapshot,
    SqlExecutionState,
    SqlExecutionSummary,
} from "@/types/ipc";

import {
    sqlExecutionDetailContributorRegistry,
    type SqlExecutionDetailContext,
} from "./execution-detail-contributor-registry";

type DetailPair = [string, string];

export interface SqlExecutionDetailSummaryRow {
    label: string;
    value: string;
}

export interface SqlExecutionDetailModel {
    stateLabel: string;
    identity: DetailPair[];
    status: DetailPair[];
    timeline: DetailPair[];
    options: DetailPair[];
    summary: SqlExecutionDetailSummaryRow[];
    failure: DetailPair[];
    cancellation: DetailPair[];
    rawArtifact: DetailPair[];
}

export interface SqlExecutionDetailModelInput {
    context: SqlExecutionDetailContext;
    timeline: SqlExecutionTimelineEntry[];
    options: SqlEditorExecutionOptionsState;
}

export interface ExecutionDetailDrawerProps
    extends SqlExecutionDetailModelInput {
    open: boolean;
    onOpenChange(open: boolean): void;
}

const STATE_LABELS: Record<SqlExecutionState, string> = {
    queued: "准备执行",
    starting: "准备执行",
    running: "正在执行",
    canceling: "正在取消",
    succeeded: "查询已完成",
    failed: "查询失败",
    timedOut: "查询超时",
    canceled: "查询已取消",
    cancelFailed: "取消未确认",
};

function formatTimestamp(value: number): string {
    return new Date(value).toISOString();
}

function formatElapsed(snapshot: SqlExecutionSnapshot): string {
    const elapsedMs = Math.max(
        0,
        (snapshot.finishedAt ?? Date.now()) - snapshot.startedAt,
    );
    return elapsedMs < 1_000
        ? `${elapsedMs}ms`
        : `${(elapsedMs / 1_000).toFixed(1)}s`;
}

function formatMetric(value: JsonSafeInteger): string {
    return String(value);
}

function buildSummaryRows(
    summary: SqlExecutionSummary | null,
): SqlExecutionDetailSummaryRow[] {
    if (!summary) return [];
    const rows: SqlExecutionDetailSummaryRow[] = [];
    const addMetric = (
        label: string,
        value: JsonSafeInteger | undefined,
    ): void => {
        if (value === undefined) return;
        rows.push({ label, value: formatMetric(value) });
    };
    addMetric("读取行数", summary.readRows);
    addMetric("读取字节数", summary.readBytes);
    addMetric("写入行数", summary.writtenRows);
    addMetric("写入字节数", summary.writtenBytes);
    addMetric("待读总行数", summary.totalRowsToRead);
    addMetric("结果行数", summary.resultRows);
    addMetric("结果字节数", summary.resultBytes);
    addMetric("服务端耗时（ns）", summary.elapsedNs);
    addMetric("内存用量", summary.memoryUsage);
    rows.push({ label: "摘要来源", value: summary.source });
    rows.push({ label: "完整度", value: summary.completeness });
    return rows;
}

export function buildSqlExecutionDetailModel({
    context,
    timeline,
    options,
}: SqlExecutionDetailModelInput): SqlExecutionDetailModel {
    const { snapshot } = context;
    return {
        stateLabel: STATE_LABELS[snapshot.state],
        identity: [
            ["Execution ID", snapshot.executionId],
            ["Query ID", snapshot.queryId],
            ["语句类型", snapshot.statementClass.toUpperCase()],
        ],
        status: [
            ["状态", STATE_LABELS[snapshot.state]],
            ["Revision", String(snapshot.revision)],
            ["开始时间", formatTimestamp(snapshot.startedAt)],
            ...(snapshot.finishedAt == null
                ? []
                : ([
                      ["完成时间", formatTimestamp(snapshot.finishedAt)],
                  ] as DetailPair[])),
            ["已耗时", formatElapsed(snapshot)],
            ["实时进度", snapshot.progressAvailable ? "可用" : "不可用"],
        ],
        timeline: timeline
            .filter((entry) => entry.executionId === snapshot.executionId)
            .map((entry) => [
                STATE_LABELS[entry.state],
                `${formatTimestamp(entry.observedAt)} · revision ${entry.revision}`,
            ]),
        options: [
            [
                "超时",
                options.timeoutMs == null
                    ? "无限制"
                    : `${options.timeoutMs / 1_000}s`,
            ],
            ["结果模式", options.resultMode.toUpperCase()],
        ],
        summary: buildSummaryRows(snapshot.summary),
        failure: snapshot.failure
            ? [
                  ["错误码", snapshot.failure.code],
                  ["运行时影响", snapshot.failure.runtimeImpact],
                  ["错误信息", snapshot.failure.message],
              ]
            : [],
        cancellation: snapshot.cancelMessage
            ? [["取消结果", snapshot.cancelMessage]]
            : [],
        rawArtifact:
            snapshot.outcome?.kind === "raw"
                ? [
                      ["格式", snapshot.outcome.format ?? "服务器默认格式"],
                      ["媒体类型", snapshot.outcome.mediaType],
                      ["字节数", String(snapshot.outcome.byteLength)],
                      [
                          "预览状态",
                          snapshot.outcome.previewTruncated
                              ? "已截断"
                              : "完整预览",
                      ],
                      ["Artifact ID", snapshot.outcome.artifactId],
                      ["可用操作", "可另存"],
                  ]
                : [],
    };
}

interface DetailSectionProps {
    title: string;
    rows: DetailPair[];
}

const DetailSection: FC<DetailSectionProps> = ({ title, rows }) => {
    if (rows.length === 0) return null;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                {rows.map(([label, value]) => (
                    <Fragment key={`${label}-${value}`}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="break-all text-foreground">{value}</dd>
                    </Fragment>
                ))}
            </dl>
        </section>
    );
};

function ExecutionDetailSections({
    model,
}: {
    model: SqlExecutionDetailModel;
}): ReactNode {
    return (
        <div className="flex flex-col gap-5">
            <DetailSection title="标识" rows={model.identity} />
            <DetailSection title="状态" rows={model.status} />
            <DetailSection title="时间线" rows={model.timeline} />
            <DetailSection title="执行选项" rows={model.options} />
            <DetailSection
                title="执行摘要"
                rows={model.summary.map((row) => [row.label, row.value])}
            />
            <DetailSection title="Raw artifact" rows={model.rawArtifact} />
            <DetailSection title="失败信息" rows={model.failure} />
            <DetailSection title="取消信息" rows={model.cancellation} />
        </div>
    );
}

export const ExecutionDetailDrawer: FC<ExecutionDetailDrawerProps> = ({
    open,
    onOpenChange,
    context,
    timeline,
    options,
}) => {
    const model = buildSqlExecutionDetailModel({
        context,
        timeline,
        options,
    });
    const contributors =
        sqlExecutionDetailContributorRegistry.resolve(context);

    return (
        <Drawer
            open={open}
            onOpenChange={onOpenChange}
            direction="right"
        >
            <DrawerContent className="sm:max-w-lg">
                <DrawerHeader>
                    <DrawerTitle>执行详情</DrawerTitle>
                    <DrawerDescription>{model.stateLabel}</DrawerDescription>
                </DrawerHeader>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                    <ExecutionDetailSections model={model} />
                    {contributors.map((contributor) => (
                        <Fragment key={contributor.id}>
                            {contributor.render(context)}
                        </Fragment>
                    ))}
                </div>
            </DrawerContent>
        </Drawer>
    );
};
