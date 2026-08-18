import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { TableIndexDraft } from "@/types/table-design";

import type { TableDesignDriverProfile } from "../driver-profiles";

interface IndexPropertiesPanelProps {
    index: TableIndexDraft | null;
    profile: TableDesignDriverProfile;
    onChange: (patch: Partial<TableIndexDraft>) => void;
}

export function IndexPropertiesPanel({
    index,
    profile,
    onChange,
}: IndexPropertiesPanelProps) {
    if (!index) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                选择一个索引后编辑列顺序、唯一性和索引方法。
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
            <div className="grid gap-1.5">
                <Label>索引名</Label>
                <Input
                    value={index.name}
                    onChange={(event) => onChange({ name: event.target.value })}
                />
            </div>
            <div className="grid gap-1.5">
                <Label>列顺序</Label>
                <Input
                    value={index.columns}
                    onChange={(event) => onChange({ columns: event.target.value })}
                    placeholder="id, created_at"
                />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <Label>唯一索引</Label>
                <Switch
                    checked={index.isUnique}
                    onCheckedChange={(checked) => onChange({ isUnique: checked })}
                />
            </div>
            {profile.indexMethods.length > 0 && (
                <div className="grid gap-1.5">
                    <Label>索引方法</Label>
                    <Select
                        value={index.method || profile.defaults.indexMethod}
                        onValueChange={(method) => {
                            if (method != null) onChange({ method });
                        }}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {profile.indexMethods.map((method) => (
                                <SelectItem key={method} value={method}>
                                    {method}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
            {profile.constraintOptions.comments && (
                <div className="grid gap-1.5">
                    <Label>注释</Label>
                    <Textarea
                        value={index.comment}
                        onChange={(event) => onChange({ comment: event.target.value })}
                        className="min-h-20"
                    />
                </div>
            )}
        </div>
    );
}
