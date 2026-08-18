import type { FC } from "react";
import { LockKeyhole } from "lucide-react";

import {
    Alert,
    AlertDescription,
    AlertTitle,
} from "@/components/ui/alert";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { cloneClickHouseTableEditDraft } from "../clickhouse-table-edit-draft";
import type { ClickHouseEditSectionProps } from "./clickhouse-columns-edit";

function errorsForPath(
    issues: ClickHouseEditSectionProps["issues"],
    path: string,
): Array<{ message: string }> {
    return issues
        .filter((issue) => issue.path === path)
        .map((issue) => ({ message: issue.message }));
}

export const ClickHouseEngineKeysEdit: FC<ClickHouseEditSectionProps> = ({
    draft,
    issues,
    disabled,
    onChange,
}) => {
    const table = draft.table;
    const updateSampleBy = (value: string): void => {
        const next = cloneClickHouseTableEditDraft(draft);
        next.table.sampleBy = value;
        onChange(next);
    };

    return (
        <div className="flex flex-col gap-4">
            <Alert>
                <LockKeyhole />
                <AlertTitle>可编辑范围</AlertTitle>
                <AlertDescription>
                    为避免改变表的数据组织方式，Engine、ORDER BY、PARTITION BY 与 PRIMARY KEY 保持只读；当前只能修改 SAMPLE BY。如需调整其他项目，请确认迁移影响后使用 SQL 编辑器。
                </AlertDescription>
            </Alert>
            <section className="rounded-lg border bg-card p-4 shadow-xs">
                <FieldGroup className="grid gap-4 xl:grid-cols-2">
                    <Field data-disabled>
                        <FieldLabel>Engine</FieldLabel>
                        <Input
                            value={`${table.engineFamily}${
                                table.engineArguments.length > 0
                                    ? `(${table.engineArguments.join(", ")})`
                                    : ""
                            }`}
                            disabled
                        />
                    </Field>
                    <Field data-disabled>
                        <FieldLabel>ORDER BY</FieldLabel>
                        <Textarea value={table.orderBy} disabled />
                    </Field>
                    <Field data-disabled>
                        <FieldLabel>PARTITION BY</FieldLabel>
                        <Textarea
                            value={table.partitionBy}
                            placeholder="未设置"
                            disabled
                        />
                    </Field>
                    <Field data-disabled>
                        <FieldLabel>PRIMARY KEY</FieldLabel>
                        <Textarea
                            value={table.primaryKey}
                            placeholder="未设置"
                            disabled
                        />
                    </Field>
                    <Field
                        data-invalid={errorsForPath(issues, "sampleBy").length > 0}
                        className="xl:col-span-2"
                    >
                        <FieldLabel>SAMPLE BY</FieldLabel>
                        <Textarea
                            value={table.sampleBy}
                            placeholder="cityHash64(id)"
                            disabled={disabled}
                            aria-invalid={
                                errorsForPath(issues, "sampleBy").length > 0
                            }
                            onChange={(event) =>
                                updateSampleBy(event.target.value)
                            }
                        />
                        <FieldError
                            errors={errorsForPath(issues, "sampleBy")}
                        />
                    </Field>
                </FieldGroup>
            </section>
        </div>
    );
};
