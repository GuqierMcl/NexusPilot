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

import type { TableDesignDriverProfile } from "../driver-profiles";
import { formatColumnType } from "./column-type-format";
import type { ColumnTypeDraft } from "./column-type-model";

interface ColumnTypeEditorProps {
    profile: TableDesignDriverProfile;
    value: ColumnTypeDraft;
    onChange: (next: ColumnTypeDraft, typeName: string) => void;
}

export function ColumnTypeEditor({ profile, value, onChange }: ColumnTypeEditorProps) {
    const definition =
        profile.typeCatalog.find((item) => item.baseType === value.baseType) ??
        profile.typeCatalog[0];

    function commit(next: ColumnTypeDraft) {
        onChange(next, formatColumnType(next, profile));
    }

    return (
        <div className="grid gap-3">
            <div className="grid grid-cols-[1fr_120px] gap-2">
                <div className="grid gap-1.5">
                    <Label>类型</Label>
                    <Select
                        value={value.mode === "raw" ? "__raw" : value.baseType}
                        items={[
                            ...profile.typeCatalog.map((item) => ({
                                value: item.baseType,
                                label: item.label,
                            })),
                            { value: "__raw", label: "Raw SQL Type" },
                        ]}
                        onValueChange={(baseType) => {
                            if (baseType === "__raw") {
                                commit({
                                    ...value,
                                    mode: "raw",
                                    rawTypeName:
                                        value.rawTypeName || formatColumnType(value, profile),
                                });
                                return;
                            }

                            const nextDefinition =
                                profile.typeCatalog.find((item) => item.baseType === baseType) ??
                                profile.typeCatalog[0];
                            commit({
                                mode: "structured",
                                family: nextDefinition.family,
                                baseType: nextDefinition.baseType,
                                length: nextDefinition.defaultLength ?? "",
                                precision: nextDefinition.defaultPrecision ?? "",
                                scale: nextDefinition.defaultScale ?? "",
                                timePrecision: nextDefinition.defaultTimePrecision ?? "",
                                unsigned: false,
                                charSemantics: "",
                                enumValues: [],
                                rawTypeName: "",
                            });
                        }}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {profile.typeCatalog.map((item) => (
                                <SelectItem key={item.baseType} value={item.baseType}>
                                    {item.label}
                                </SelectItem>
                            ))}
                            <SelectItem value="__raw">Raw SQL Type</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div className="grid gap-1.5">
                    <Label>模式</Label>
                    <div className="flex h-9 items-center rounded-md border px-3 text-xs text-muted-foreground">
                        {value.mode === "raw" ? "Raw" : "Structured"}
                    </div>
                </div>
            </div>

            {value.mode === "raw" ? (
                <div className="grid gap-1.5">
                    <Label>Raw 类型</Label>
                    <Input
                        value={value.rawTypeName}
                        onChange={(event) =>
                            commit({ ...value, rawTypeName: event.target.value })
                        }
                        placeholder="GEOGRAPHY(Point, 4326)"
                    />
                </div>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {definition?.supportsLength && (
                        <div className="grid gap-1.5">
                            <Label>长度</Label>
                            <Input
                                value={value.length}
                                onChange={(event) =>
                                    commit({ ...value, length: event.target.value })
                                }
                            />
                        </div>
                    )}
                    {definition?.supportsPrecisionScale && (
                        <>
                            <div className="grid gap-1.5">
                                <Label>精度</Label>
                                <Input
                                    value={value.precision}
                                    onChange={(event) =>
                                        commit({ ...value, precision: event.target.value })
                                    }
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <Label>小数位</Label>
                                <Input
                                    value={value.scale}
                                    onChange={(event) =>
                                        commit({ ...value, scale: event.target.value })
                                    }
                                />
                            </div>
                        </>
                    )}
                    {definition?.supportsTimePrecision && (
                        <div className="grid gap-1.5">
                            <Label>时间精度</Label>
                            <Input
                                value={value.timePrecision}
                                onChange={(event) =>
                                    commit({ ...value, timePrecision: event.target.value })
                                }
                            />
                        </div>
                    )}
                    {definition?.supportsCharSemantics && (
                        <div className="grid gap-1.5">
                            <Label>长度语义</Label>
                            <Select
                                value={value.charSemantics || "__default"}
                                items={[
                                    { value: "__default", label: "默认" },
                                    { value: "byte", label: "BYTE" },
                                    { value: "char", label: "CHAR" },
                                ]}
                                onValueChange={(next) =>
                                    commit({
                                        ...value,
                                        charSemantics:
                                            next === "__default"
                                                ? ""
                                                : (next as "byte" | "char"),
                                    })
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="__default">默认</SelectItem>
                                    <SelectItem value="byte">BYTE</SelectItem>
                                    <SelectItem value="char">CHAR</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    {definition?.supportsUnsigned && profile.columnOptions.unsigned && (
                        <div className="flex items-center justify-between rounded-md border px-3 py-2">
                            <Label>Unsigned</Label>
                            <Switch
                                checked={value.unsigned}
                                onCheckedChange={(checked) =>
                                    commit({ ...value, unsigned: checked })
                                }
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
