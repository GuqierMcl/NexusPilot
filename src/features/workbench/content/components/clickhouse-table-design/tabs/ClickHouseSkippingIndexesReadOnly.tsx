import { ScanSearch } from "lucide-react";

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
import type { ClickHouseSkippingIndexSchema } from "@/types/ipc";

interface ClickHouseSkippingIndexesReadOnlyProps {
    indexes: ClickHouseSkippingIndexSchema[];
}

function formatIndexType(index: ClickHouseSkippingIndexSchema): string {
    return index.typeArguments.length > 0
        ? `${index.indexType}(${index.typeArguments.join(", ")})`
        : index.indexType;
}

export function ClickHouseSkippingIndexesReadOnly({
    indexes,
}: ClickHouseSkippingIndexesReadOnlyProps) {
    if (indexes.length === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <ScanSearch />
                    </EmptyMedia>
                    <EmptyTitle>没有 Data-skipping Index 对象</EmptyTitle>
                    <EmptyDescription>
                        远端表没有定义 data-skipping index 对象。
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        );
    }

    return (
        <div className="overflow-hidden rounded-lg border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>表达式</TableHead>
                        <TableHead>类型与参数</TableHead>
                        <TableHead>Granularity</TableHead>
                        <TableHead>对象阻断</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {indexes.map((index) => (
                        <TableRow key={index.name}>
                            <TableCell className="font-medium">{index.name}</TableCell>
                            <TableCell className="max-w-xl whitespace-normal font-mono text-xs">
                                {index.expression || "未定义"}
                            </TableCell>
                            <TableCell>{formatIndexType(index)}</TableCell>
                            <TableCell>{index.granularity ?? "未定义"}</TableCell>
                            <TableCell className="max-w-72 whitespace-normal text-muted-foreground">
                                {index.editability.blockers.length > 0
                                    ? index.editability.blockers
                                          .map((blocker) => blocker.message)
                                          .join("；")
                                    : "无阻断"}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
