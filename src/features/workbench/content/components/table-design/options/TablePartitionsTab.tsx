import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TableSchemaDraft } from "@/types/table-design";

interface TablePartitionsTabProps {
    mode: "create" | "edit";
    driver: string | null;
    draft: TableSchemaDraft;
    onBasicsFieldChange: (field: keyof TableSchemaDraft["basics"], value: string) => void;
}

export function TablePartitionsTab({
    mode,
    driver,
    draft,
    onBasicsFieldChange,
}: TablePartitionsTabProps) {
    return (
        <div className="grid gap-4 p-4">
            {draft.basics.partitionReadonlyDescription ? (
                <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs">
                    {draft.basics.partitionReadonlyDescription}
                </div>
            ) : (
                <div className="grid gap-3 md:grid-cols-[1fr_2fr]">
                    <div className="space-y-1.5">
                        <Label>分区表达式</Label>
                        <Input
                            value={draft.basics.partitionExpression}
                            onChange={(event) =>
                                onBasicsFieldChange("partitionExpression", event.target.value)
                            }
                            placeholder={
                                driver === "postgres" || driver === "oracle"
                                    ? "RANGE (created_at)"
                                    : "HASH(id)"
                            }
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>原始分区子句</Label>
                        <Textarea
                            value={draft.basics.partitionRawClause}
                            onChange={(event) =>
                                onBasicsFieldChange("partitionRawClause", event.target.value)
                            }
                            placeholder={
                                driver === "postgres"
                                    ? "PARTITION BY RANGE (created_at)"
                                    : driver === "oracle"
                                      ? 'PARTITION BY RANGE ("CREATED_AT") (...)'
                                      : "PARTITION BY HASH(id) PARTITIONS 4"
                            }
                            className="min-h-24"
                        />
                    </div>
                </div>
            )}
            {mode === "edit" && !draft.basics.partitionReadonlyDescription ? (
                <Alert>
                    <AlertDescription>
                        已有表暂不支持通过设计器修改分区；非空分区子句会在保存时被后端拒绝。
                    </AlertDescription>
                </Alert>
            ) : null}
        </div>
    );
}
