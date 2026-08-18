import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import type { ClickHouseTableDesignViewModel } from "@/types/clickhouse-table-design";

interface ClickHouseEngineKeysReadOnlyProps {
    model: ClickHouseTableDesignViewModel;
}

export function ClickHouseEngineKeysReadOnly({
    model,
}: ClickHouseEngineKeysReadOnlyProps) {
    const facts = [
        ["Engine family", model.engine.family],
        ["Engine arguments", model.engine.arguments.join(", ") || "未定义"],
        ["Engine expression", model.engine.rawExpression || "未定义"],
        ["ORDER BY", model.keys.orderBy || "未定义"],
        ["PARTITION BY", model.keys.partitionBy || "未定义"],
        ["PRIMARY KEY", model.keys.primaryKey || "未定义"],
        ["SAMPLE BY", model.keys.sampleBy || "未定义"],
        ["Table comment", model.comment || "未定义"],
    ] as const;

    return (
        <div className="overflow-hidden rounded-lg border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>结构项</TableHead>
                        <TableHead>远端定义</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {facts.map(([label, value]) => (
                        <TableRow key={label}>
                            <TableCell className="font-medium">{label}</TableCell>
                            <TableCell className="whitespace-normal font-mono text-xs">
                                {value}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
