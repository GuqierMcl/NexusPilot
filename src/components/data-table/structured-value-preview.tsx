import { type FC, useMemo, useState } from "react";
import { Braces, Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const SUMMARY_MAX_LENGTH = 120;
const DETAIL_MAX_LENGTH = 64 * 1024;
const UNSERIALIZABLE_STRUCTURE = "<不可序列化结构>";

export interface StructuredValuePreviewProps {
  value: unknown;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 0) return "";
  if (maxLength === 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

export function formatStructuredValue(
  value: unknown,
  maxLength = DETAIL_MAX_LENGTH,
): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    const text = serialized ?? String(value);
    return truncateText(text, Math.max(0, maxLength));
  } catch {
    return UNSERIALIZABLE_STRUCTURE;
  }
}

function summarizeStructuredValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value !== null && typeof value === "object") {
    return `${Object.keys(value).length} 个字段`;
  }
  return formatStructuredValue(value, SUMMARY_MAX_LENGTH);
}

export const StructuredValuePreview: FC<StructuredValuePreviewProps> = ({
  value,
}) => {
  const [copied, setCopied] = useState(false);
  const summary = useMemo(() => summarizeStructuredValue(value), [value]);
  const detailText = useMemo(
    () => formatStructuredValue(value, DETAIL_MAX_LENGTH),
    [value],
  );

  const copyValue = (): void => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(detailText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    });
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="查看结构化值"
          className="h-6 max-w-full justify-start gap-1.5 px-1.5 font-mono text-xs"
        >
          <Braces className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{summary}</span>
          <span className="sr-only">结构化值</span>
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>结构化值</DialogTitle>
          <DialogDescription>
            以只读 JSON 形式显示；超出安全上限的内容会在末尾标记省略号。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={copyValue}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {detailText}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  );
};
