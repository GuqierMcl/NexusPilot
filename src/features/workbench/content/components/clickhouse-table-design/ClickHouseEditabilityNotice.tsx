import { Info, TriangleAlert } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import type { ClickHouseTableDesignViewModel } from "@/types/clickhouse-table-design";

interface ClickHouseEditabilityNoticeProps {
    model: ClickHouseTableDesignViewModel;
}

export function ClickHouseEditabilityNotice({
    model,
}: ClickHouseEditabilityNoticeProps) {
    const hasBlockers = model.blockers.length > 0;
    const Icon = hasBlockers ? TriangleAlert : Info;

    return (
        <Alert>
            <Icon />
            <AlertTitle>
                {hasBlockers ? "部分结构暂不可编辑" : "只读结构信息"}
            </AlertTitle>
            <AlertDescription>
                <div className="flex flex-col gap-2">
                    <p>
                        当前页面用于查看远端结构，不能直接保存修改；如需变更，请使用支持编辑的表设计页面或 SQL 编辑器。
                    </p>
                    {hasBlockers && (
                        <ul className="flex max-h-32 list-disc flex-col gap-1 overflow-auto pl-4">
                            {model.blockers.map((blocker, index) => (
                                <li key={`${blocker.code}-${blocker.path}-${index}`}>
                                    <span className="font-medium text-foreground">
                                        {blocker.path}
                                    </span>
                                    {" · "}
                                    {blocker.message}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </AlertDescription>
        </Alert>
    );
}
