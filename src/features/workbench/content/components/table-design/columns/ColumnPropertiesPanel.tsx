import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { TableColumnDraft } from "@/types/table-design";

import type { TableDesignDriverProfile } from "../driver-profiles";
import { ColumnTypeEditor } from "./ColumnTypeEditor";

interface ColumnPropertiesPanelProps {
    column: TableColumnDraft | null;
    profile: TableDesignDriverProfile;
    onChange: (patch: Partial<TableColumnDraft>) => void;
}

export function ColumnPropertiesPanel({
    column,
    profile,
    onChange,
}: ColumnPropertiesPanelProps) {
    if (!column) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                选择一列后编辑类型、默认值和高级属性。
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
            <div className="grid gap-1.5">
                <Label>列名</Label>
                <Input
                    value={column.name}
                    onChange={(event) => onChange({ name: event.target.value })}
                />
            </div>
            <ColumnTypeEditor
                profile={profile}
                value={column.typeDraft}
                onChange={(typeDraft, typeName) => onChange({ typeDraft, typeName })}
            />
            <div className="grid gap-1.5">
                <Label>默认值</Label>
                <Input
                    value={column.defaultValue}
                    onChange={(event) => onChange({ defaultValue: event.target.value })}
                    placeholder="'anonymous' / CURRENT_TIMESTAMP"
                />
            </div>
            <div className="grid gap-2">
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <Label>可空</Label>
                    <Switch
                        checked={column.nullable}
                        onCheckedChange={(checked) => onChange({ nullable: checked })}
                    />
                </div>
                <div className="flex items-center justify-between rounded-md border px-3 py-2">
                    <Label>{profile.driver === "mysql" ? "AUTO_INCREMENT" : "Identity"}</Label>
                    <Switch
                        checked={column.isIdentity}
                        onCheckedChange={(checked) => onChange({ isIdentity: checked })}
                    />
                </div>
            </div>
            {profile.columnOptions.charset && (
                <div className="grid gap-1.5">
                    <Label>列字符集</Label>
                    <Input
                        value={column.charset}
                        onChange={(event) => onChange({ charset: event.target.value })}
                    />
                </div>
            )}
            {profile.columnOptions.collation && (
                <div className="grid gap-1.5">
                    <Label>排序规则</Label>
                    <Input
                        value={column.collation}
                        onChange={(event) => onChange({ collation: event.target.value })}
                    />
                </div>
            )}
            <div className="grid gap-1.5">
                <Label>生成表达式</Label>
                <Textarea
                    value={column.generatedExpression}
                    onChange={(event) => onChange({ generatedExpression: event.target.value })}
                    className="min-h-20"
                />
            </div>
            <div className="grid gap-1.5">
                <Label>注释</Label>
                <Textarea
                    value={column.comment}
                    onChange={(event) => onChange({ comment: event.target.value })}
                    className="min-h-20"
                />
            </div>
        </div>
    );
}
