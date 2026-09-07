import type { FC } from "react";
import {
  referenceKey,
  type ReferencedText,
  type TextReferences,
  type ReferenceTarget,
} from "../../../../../shared/composer-references";
import type { SourceAvailability } from "./composer-registry";

export const ReferenceText: FC<ReferencedText> = ({
  text,
  references,
  command,
}) => {
  const parts = [];
  let start = 0;
  for (const item of [
    ...(references?.occurrences ?? []),
    ...(command ? [command] : []),
  ].sort((a, b) => a.start - b.start)) {
    parts.push(
      <span key={`before-${item.id}`}>{text.slice(start, item.start)}</span>,
    );
    parts.push(
      <mark key={item.id} className="rounded-sm bg-primary/15 text-primary">
        {text.slice(item.start, item.end)}
      </mark>,
    );
    start = item.end;
  }
  parts.push(<span key="tail">{text.slice(start)}</span>);
  return <>{parts}</>;
};

interface ReferenceDetailsProps {
  references?: TextReferences;
  onRemove?: (key: string) => void;
  statusFor?: (target: ReferenceTarget) => SourceAvailability;
}
export const ReferenceDetails: FC<ReferenceDetailsProps> = ({
  references,
  onRemove,
  statusFor,
}) => {
  if (!references?.targets.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1" aria-label="已引用的上下文">
      {references.targets.map((target) => {
        const key = referenceKey(target);
        const count = references.occurrences.filter(
          (item) => item.targetKey === key,
        ).length;
        const status = statusFor?.(target);
        return (
          <div
            key={key}
            className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"
          >
            <details className="min-w-0">
              <summary className="cursor-pointer truncate text-primary">
                @{target.label}
                {count > 1 ? ` ×${count}` : ""}
              </summary>
              <div className="max-w-80 break-all py-1 text-muted-foreground">
                <div>
                  {target.type} · {target.id}
                </div>
                {Object.entries(target.data).map(([field, value]) => (
                  <div key={field}>
                    {field}: {String(value)}
                  </div>
                ))}
                {status && !status.available && (
                  <div role="status">{status.reason}</div>
                )}
              </div>
            </details>
            {onRemove && (
              <button
                type="button"
                className="rounded px-1 hover:bg-accent"
                aria-label={`移除 ${target.label} 的引用`}
                onClick={() => onRemove(key)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
