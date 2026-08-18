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
import type { TableConstraintDraft } from "@/types/table-design";

import type { TableDesignDriverProfile } from "../driver-profiles";

const ACTION_OPTIONS = ["no_action", "restrict", "cascade", "set_null", "set_default"] as const;

interface ConstraintPropertiesPanelProps {
    constraint: TableConstraintDraft | null;
    profile: TableDesignDriverProfile;
    onChange: (patch: Partial<TableConstraintDraft>) => void;
}

export function ConstraintPropertiesPanel({
    constraint,
    profile,
    onChange,
}: ConstraintPropertiesPanelProps) {
    if (!constraint) {
        return (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
                选择一个约束后编辑列、引用关系或表达式。
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
            <div className="grid gap-1.5">
                <Label>约束名</Label>
                <Input
                    value={constraint.name}
                    onChange={(event) => onChange({ name: event.target.value })}
                />
            </div>
            <div className="grid gap-1.5">
                <Label>类型</Label>
                <Select
                    value={constraint.kind}
                    items={[
                        { value: "primary_key", label: "Primary Key" },
                        { value: "unique", label: "Unique" },
                        { value: "foreign_key", label: "Foreign Key" },
                        { value: "check", label: "Check" },
                    ]}
                    onValueChange={(kind) =>
                        onChange({ kind: kind as TableConstraintDraft["kind"] })
                    }
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="primary_key">Primary Key</SelectItem>
                        <SelectItem value="unique">Unique</SelectItem>
                        <SelectItem value="foreign_key">Foreign Key</SelectItem>
                        <SelectItem value="check">Check</SelectItem>
                    </SelectContent>
                </Select>
            </div>
            <div className="grid gap-1.5">
                <Label>本地列顺序</Label>
                <Input
                    value={constraint.columns}
                    onChange={(event) => onChange({ columns: event.target.value })}
                    placeholder="tenant_id, user_id"
                />
            </div>
            {constraint.kind === "foreign_key" && (
                <>
                    <div className="grid gap-1.5">
                        <Label>引用 Schema / Database</Label>
                        <Input
                            value={constraint.referenceSchema}
                            onChange={(event) =>
                                onChange({ referenceSchema: event.target.value })
                            }
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label>引用表</Label>
                        <Input
                            value={constraint.referenceTable}
                            onChange={(event) =>
                                onChange({ referenceTable: event.target.value })
                            }
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <Label>引用列顺序</Label>
                        <Input
                            value={constraint.referenceColumns}
                            onChange={(event) =>
                                onChange({ referenceColumns: event.target.value })
                            }
                            placeholder="tenant_id, id"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <ReferentialActionSelect
                            label="ON UPDATE"
                            value={constraint.onUpdate}
                            onChange={(onUpdate) => onChange({ onUpdate })}
                        />
                        <ReferentialActionSelect
                            label="ON DELETE"
                            value={constraint.onDelete}
                            onChange={(onDelete) => onChange({ onDelete })}
                        />
                    </div>
                </>
            )}
            {constraint.kind === "check" && (
                <div className="grid gap-1.5">
                    <Label>CHECK 表达式</Label>
                    <Textarea
                        value={constraint.expression}
                        onChange={(event) => onChange({ expression: event.target.value })}
                        className="min-h-24"
                    />
                </div>
            )}
            {profile.constraintOptions.enforced &&
                (constraint.kind === "check" || constraint.kind === "foreign_key") && (
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <Label>Enforced</Label>
                        <Switch
                            checked={constraint.enforced}
                            onCheckedChange={(checked) => onChange({ enforced: checked })}
                        />
                    </div>
                )}
            {profile.constraintOptions.comments && (
                <div className="grid gap-1.5">
                    <Label>注释</Label>
                    <Textarea
                        value={constraint.comment}
                        onChange={(event) => onChange({ comment: event.target.value })}
                        className="min-h-20"
                    />
                </div>
            )}
        </div>
    );
}

function ReferentialActionSelect({
    label,
    value,
    onChange,
}: {
    label: string;
    value: TableConstraintDraft["onUpdate"];
    onChange: (value: TableConstraintDraft["onUpdate"]) => void;
}) {
    return (
        <div className="grid gap-1.5">
            <Label>{label}</Label>
            <Select
                value={value || "__default"}
                items={[
                    { value: "__default", label: "默认" },
                    ...ACTION_OPTIONS.map((action) => ({
                        value: action,
                        label: action,
                    })),
                ]}
                onValueChange={(next) =>
                    onChange(
                        next === "__default"
                            ? ""
                            : (next as TableConstraintDraft["onUpdate"]),
                    )
                }
            >
                <SelectTrigger>
                    <SelectValue placeholder="默认" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="__default">默认</SelectItem>
                    {ACTION_OPTIONS.map((action) => (
                        <SelectItem key={action} value={action}>
                            {action}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}
