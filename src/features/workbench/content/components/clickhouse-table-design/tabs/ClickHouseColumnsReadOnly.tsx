import { Columns3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import type { ClickHouseColumnSchema } from "@/types/ipc";

interface ClickHouseColumnsReadOnlyProps {
    columns: ClickHouseColumnSchema[];
}

function optionalFact(value: string | null): string {
    return value?.trim() || "未定义";
}

function blockerLabel(column: ClickHouseColumnSchema): string {
    if (column.editability.blockers.length === 0) return "无阻断";
    return column.editability.blockers
        .map((blocker) => blocker.message)
        .join("；");
}

export function ClickHouseColumnsReadOnly({
    columns,
}: ClickHouseColumnsReadOnlyProps) {
    if (columns.length === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Columns3 />
                    </EmptyMedia>
                    <EmptyTitle>没有列</EmptyTitle>
                    <EmptyDescription>远端结构没有返回列定义。</EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div className="overflow-hidden rounded-lg border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>位置</TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>默认值</TableHead>
                        <TableHead>CODEC</TableHead>
                        <TableHead>列 TTL</TableHead>
                        <TableHead>注释</TableHead>
                        <TableHead>结构阻断</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {columns.map((column) => (
                        <TableRow key={`${column.position}-${column.name}`}>
                            <TableCell>{column.position}</TableCell>
                            <TableCell className="font-medium">{column.name}</TableCell>
                            <TableCell>{column.typeName}</TableCell>
                            <TableCell>
                                <div className="flex min-w-40 flex-col items-start gap-1">
                                    <Badge variant="outline">
                                        {column.defaultKind}
                                    </Badge>
                                    <span className="whitespace-normal text-muted-foreground">
                                        {optionalFact(column.defaultExpression)}
                                    </span>
                                </div>
                            </TableCell>
                            <TableCell className="max-w-64 whitespace-normal">
                                {optionalFact(column.codecExpression)}
                            </TableCell>
                            <TableCell className="max-w-72 whitespace-normal">
                                {optionalFact(column.ttlExpression)}
                            </TableCell>
                            <TableCell className="max-w-64 whitespace-normal">
                                {optionalFact(column.comment)}
                            </TableCell>
                            <TableCell className="max-w-72 whitespace-normal text-muted-foreground">
                                {blockerLabel(column)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
