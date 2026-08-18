import type { FC } from "react";
import { Binary, FileOutput } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatJsonSafeInteger } from "@/lib/json-safe-integer";
import type { SqlExecutionOutcome } from "@/types/ipc";

export interface RawSqlResultViewProps {
    outcome: Extract<SqlExecutionOutcome, { kind: "raw" }>;
    isSaving: boolean;
    canSave?: boolean;
    onSave(): void;
}

export const RawSqlResultView: FC<RawSqlResultViewProps> = ({
    outcome,
    isSaving,
    canSave = true,
    onSave,
}) => {
    const isHexPreview = outcome.preview.startsWith("[hex]");
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/20 px-3 py-2 text-xs">
                <span>
                    <span className="text-muted-foreground">格式：</span>
                    {outcome.format ?? "服务器默认格式"}
                </span>
                <span>
                    <span className="text-muted-foreground">媒体类型：</span>
                    {outcome.mediaType}
                </span>
                <span>
                    <span className="text-muted-foreground">字节数：</span>
                    {formatJsonSafeInteger(outcome.byteLength)}
                </span>
                {isHexPreview ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                        <Binary className="size-3.5" />
                        Hex 预览（二进制或无效 UTF-8）
                    </span>
                ) : null}
                {outcome.previewTruncated ? (
                    <span className="text-amber-600 dark:text-amber-400">
                        预览已截断，另存文件保留完整结果
                    </span>
                ) : null}
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="ml-auto h-7"
                    disabled={isSaving || !canSave}
                    onClick={onSave}
                >
                    <FileOutput className="size-3.5" />
                    {isSaving ? "正在另存..." : "另存为"}
                </Button>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-foreground">
                {outcome.preview || "（无预览内容）"}
            </pre>
        </div>
    );
};
