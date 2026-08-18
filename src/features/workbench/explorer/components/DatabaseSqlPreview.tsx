import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

interface DatabaseSqlPreviewProps {
    statements: string[];
    emptyLabel?: string;
}

export function DatabaseSqlPreview({
    statements,
    emptyLabel = "输入信息后会在这里显示 SQL 预览。",
}: DatabaseSqlPreviewProps) {
    const preview = statements.join("\n");

    return (
        <Field>
            <FieldLabel>SQL 预览</FieldLabel>
            <FieldContent>
                <Textarea
                    readOnly
                    value={preview || emptyLabel}
                    className="min-h-32 resize-none font-mono text-xs leading-5"
                />
            </FieldContent>
        </Field>
    );
}
