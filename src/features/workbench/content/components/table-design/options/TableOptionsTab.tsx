import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TableSchemaDraft } from "@/types/table-design";

import type { TableDesignDriverProfile } from "../driver-profiles";

interface TableOptionsTabProps {
    draft: TableSchemaDraft;
    profile: TableDesignDriverProfile;
    onBasicsFieldChange: (field: keyof TableSchemaDraft["basics"], value: string) => void;
}

export function TableOptionsTab({
    draft,
    profile,
    onBasicsFieldChange,
}: TableOptionsTabProps) {
    const visibleOptionIds = new Set(profile.tableOptions.map((option) => option.id));

    return (
        <div className="grid max-w-3xl gap-4 p-4">
            {visibleOptionIds.has("engine") && (
                <div className="grid gap-1.5">
                    <Label>Engine</Label>
                    <Input
                        value={draft.basics.engine}
                        onChange={(event) => onBasicsFieldChange("engine", event.target.value)}
                        placeholder="InnoDB"
                    />
                </div>
            )}
            {visibleOptionIds.has("charset") && (
                <div className="grid gap-1.5">
                    <Label>Charset</Label>
                    <Input
                        value={draft.basics.charset}
                        onChange={(event) => onBasicsFieldChange("charset", event.target.value)}
                        placeholder="utf8mb4"
                    />
                </div>
            )}
            {visibleOptionIds.has("collation") && (
                <div className="grid gap-1.5">
                    <Label>Collation</Label>
                    <Input
                        value={draft.basics.collation}
                        onChange={(event) =>
                            onBasicsFieldChange("collation", event.target.value)
                        }
                        placeholder="utf8mb4_0900_ai_ci"
                    />
                </div>
            )}
            <div className="grid gap-1.5">
                <Label>Comment</Label>
                <Textarea
                    value={draft.basics.comment}
                    onChange={(event) => onBasicsFieldChange("comment", event.target.value)}
                    className="min-h-24"
                />
            </div>
        </div>
    );
}
