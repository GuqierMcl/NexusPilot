import { Settings2 } from "lucide-react";

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
import type { ClickHouseTableDesignViewModel } from "@/types/clickhouse-table-design";

interface ClickHouseTtlSettingsReadOnlyProps {
    model: ClickHouseTableDesignViewModel;
}

export function ClickHouseTtlSettingsReadOnly({
    model,
}: ClickHouseTtlSettingsReadOnlyProps) {
    if (!model.tableTtl && model.settings.length === 0) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Settings2 />
                    </EmptyMedia>
                    <EmptyTitle>TTL 与 Settings 未定义</EmptyTitle>
                    <EmptyDescription>
                        此表没有显式 table TTL 或 table setting。
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
                        <TableHead>类型</TableHead>
                        <TableHead>名称</TableHead>
                        <TableHead>值</TableHead>
                        <TableHead>来源</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {model.tableTtl && (
                        <TableRow>
                            <TableCell>Table TTL</TableCell>
                            <TableCell className="font-medium">TTL</TableCell>
                            <TableCell className="whitespace-normal font-mono text-xs">
                                {model.tableTtl}
                            </TableCell>
                            <TableCell>
                                <Badge variant="outline">显式</Badge>
                            </TableCell>
                        </TableRow>
                    )}
                    {model.settings.map((setting) => (
                        <TableRow key={setting.name}>
                            <TableCell>Setting</TableCell>
                            <TableCell className="font-medium">{setting.name}</TableCell>
                            <TableCell className="whitespace-normal font-mono text-xs">
                                {setting.value}
                            </TableCell>
                            <TableCell>
                                <Badge variant="outline">
                                    {setting.explicit ? "显式" : "服务器默认"}
                                </Badge>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
