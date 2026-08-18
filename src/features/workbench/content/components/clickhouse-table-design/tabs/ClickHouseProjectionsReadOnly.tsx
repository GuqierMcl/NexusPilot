import { Layers3 } from "lucide-react";

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
import type { ClickHouseProjectionSchema } from "@/types/ipc";

interface ClickHouseProjectionsReadOnlyProps {
    projections: ClickHouseProjectionSchema[];
}

export function ClickHouseProjectionsReadOnly({
    projections,
}: ClickHouseProjectionsReadOnlyProps) {
    if (projections.length === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Layers3 />
                    </EmptyMedia>
                    <EmptyTitle>没有 Projection 对象</EmptyTitle>
                    <EmptyDescription>远端表没有定义 projection 对象。</EmptyDescription>
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
                        <TableHead>查询定义</TableHead>
                        <TableHead>对象阻断</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {projections.map((projection) => (
                        <TableRow key={projection.name}>
                            <TableCell className="font-medium">
                                {projection.name}
                            </TableCell>
                            <TableCell className="max-w-3xl whitespace-pre-wrap font-mono text-xs">
                                {projection.query || "未定义"}
                            </TableCell>
                            <TableCell className="max-w-72 whitespace-normal text-muted-foreground">
                                {projection.editability.blockers.length > 0
                                    ? projection.editability.blockers
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
