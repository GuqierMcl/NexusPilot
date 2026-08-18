import type { FC } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ClickHouseTableCreateDraft } from "@/types/clickhouse-table-design";

import { cloneClickHouseTableCreateDraft } from "../clickhouse-table-create-draft";
import type { ClickHouseCreateValidationIssue } from "../clickhouse-table-create-validation";

interface ClickHouseTtlSettingsCreateProps {
    draft: ClickHouseTableCreateDraft;
    issues: readonly ClickHouseCreateValidationIssue[];
    disabled: boolean;
    onChange: (draft: ClickHouseTableCreateDraft) => void;
}

const SETTING_NAMES = [
    "index_granularity",
    "index_granularity_bytes",
    "allow_nullable_key",
    "ttl_only_drop_parts",
] as const;

function newSettingId(): string {
    return `setting-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function errorsForPath(
    issues: readonly ClickHouseCreateValidationIssue[],
    path: string,
): Array<{ message: string }> {
    return issues
        .filter((issue) => issue.path === path)
        .map((issue) => ({ message: issue.message }));
}

export const ClickHouseTtlSettingsCreate: FC<ClickHouseTtlSettingsCreateProps> = ({
    draft,
    issues,
    disabled,
    onChange,
}) => {
    const updateField = (
        field: "tableTtl" | "comment",
        value: string,
    ): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        next[field] = value;
        onChange(next);
    };

    const updateSetting = (
        settingIndex: number,
        update: (setting: ClickHouseTableCreateDraft["settings"][number]) => void,
    ): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        const setting = next.settings[settingIndex];
        if (!setting) return;
        update(setting);
        onChange(next);
    };

    const moveSetting = (settingIndex: number, offset: -1 | 1): void => {
        const next = cloneClickHouseTableCreateDraft(draft);
        const targetIndex = settingIndex + offset;
        if (targetIndex < 0 || targetIndex >= next.settings.length) return;
        const [setting] = next.settings.splice(settingIndex, 1);
        if (setting) next.settings.splice(targetIndex, 0, setting);
        onChange(next);
    };

    return (
        <div className="flex flex-col gap-4">
            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3">
                    <h3 className="text-sm font-medium">Table TTL & Comment</h3>
                    <p className="text-xs text-muted-foreground">
                        只管理当前表对象的 TTL 与注释，不修改 server/global 设置。
                    </p>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                    <Field data-invalid={errorsForPath(issues, "tableTtl").length > 0}>
                        <FieldLabel>Table TTL</FieldLabel>
                        <Textarea
                            value={draft.tableTtl}
                            placeholder="created_at + INTERVAL 30 DAY DELETE"
                            disabled={disabled}
                            aria-invalid={
                                errorsForPath(issues, "tableTtl").length > 0
                            }
                            onChange={(event) =>
                                updateField("tableTtl", event.target.value)
                            }
                        />
                        <FieldError errors={errorsForPath(issues, "tableTtl")} />
                    </Field>
                    <Field>
                        <FieldLabel>Table comment</FieldLabel>
                        <Textarea
                            value={draft.comment}
                            disabled={disabled}
                            onChange={(event) =>
                                updateField("comment", event.target.value)
                            }
                        />
                    </Field>
                </div>
            </section>

            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-medium">Explicit settings</h3>
                        <p className="text-xs text-muted-foreground">
                            仅写入显式列出的 allowlist 设置，并保留当前顺序。
                        </p>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                            const next = cloneClickHouseTableCreateDraft(draft);
                            const firstUnused = SETTING_NAMES.find(
                                (name) =>
                                    !next.settings.some(
                                        (setting) => setting.name === name,
                                    ),
                            );
                            next.settings.push({
                                id: newSettingId(),
                                name: firstUnused ?? SETTING_NAMES[0],
                                value:
                                    firstUnused === "index_granularity" ||
                                    firstUnused == null
                                        ? "8192"
                                        : "0",
                            });
                            onChange(next);
                        }}
                    >
                        <Plus data-icon="inline-start" />
                        添加设置
                    </Button>
                </div>

                {draft.settings.length === 0 ? (
                    <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                        未显式设置 table settings。
                    </p>
                ) : (
                    <div className="space-y-2">
                        {draft.settings.map((setting, settingIndex) => {
                            const path = `settings.${settingIndex}`;
                            return (
                                <div
                                    key={setting.id}
                                    className="grid items-start gap-2 rounded-md border bg-background p-2 md:grid-cols-[minmax(12rem,1fr)_minmax(10rem,1fr)_auto]"
                                >
                                    <Field>
                                        <FieldLabel>Setting</FieldLabel>
                                        <Select
                                            value={setting.name}
                                            disabled={disabled}
                                            onValueChange={(value) => {
                                                if (value == null) return;
                                                updateSetting(
                                                    settingIndex,
                                                    (current) => {
                                                        current.name = value;
                                                        current.value =
                                                            value ===
                                                            "index_granularity"
                                                                ? "8192"
                                                                : "0";
                                                    },
                                                );
                                            }}
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {SETTING_NAMES.map((name) => (
                                                    <SelectItem
                                                        key={name}
                                                        value={name}
                                                    >
                                                        {name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <FieldError
                                            errors={errorsForPath(
                                                issues,
                                                `${path}.name`,
                                            )}
                                        />
                                    </Field>
                                    <Field>
                                        <FieldLabel>Value</FieldLabel>
                                        <Input
                                            value={setting.value}
                                            disabled={disabled}
                                            onChange={(event) =>
                                                updateSetting(
                                                    settingIndex,
                                                    (current) => {
                                                        current.value =
                                                            event.target.value;
                                                    },
                                                )
                                            }
                                        />
                                        <FieldError
                                            errors={errorsForPath(
                                                issues,
                                                `${path}.value`,
                                            )}
                                        />
                                    </Field>
                                    <div className="flex gap-1 pt-6">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={
                                                disabled || settingIndex === 0
                                            }
                                            onClick={() =>
                                                moveSetting(settingIndex, -1)
                                            }
                                            aria-label="上移设置"
                                        >
                                            <ArrowUp />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={
                                                disabled ||
                                                settingIndex ===
                                                    draft.settings.length - 1
                                            }
                                            onClick={() =>
                                                moveSetting(settingIndex, 1)
                                            }
                                            aria-label="下移设置"
                                        >
                                            <ArrowDown />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={disabled}
                                            onClick={() => {
                                                const next =
                                                    cloneClickHouseTableCreateDraft(
                                                        draft,
                                                    );
                                                next.settings.splice(
                                                    settingIndex,
                                                    1,
                                                );
                                                onChange(next);
                                            }}
                                            aria-label="删除设置"
                                        >
                                            <Trash2 />
                                        </Button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
};
