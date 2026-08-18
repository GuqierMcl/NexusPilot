import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, MoreHorizontal } from "lucide-react";
import { toast } from "@/components/ui/toast";

import {
  CodeEditorDialog,
  formatJsonEditorValue,
  validateJsonEditorValue,
} from "@/components/editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DataTableColumn } from "../types";
import { AdvancedCellEditorPopover } from "./advanced-cell-editor-popover";
import { resolveAdvancedCellEditor } from "./editor-registry";
import { valueToInputText } from "./value-format";

interface CellEditorProps {
  initialValue: unknown;
  column: DataTableColumn | undefined;
  rowIndex: number;
  columnId: string;
  isActive: boolean;
  onCommit?: (rowIndex: number, columnId: string, value: unknown) => void;
  onCancel?: () => void;
}

export function CellEditor({
  initialValue,
  column,
  rowIndex,
  columnId,
  isActive,
  onCommit,
  onCancel,
}: CellEditorProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurCommitRef = useRef(false);
  const [value, setValue] = useState(() => valueToInputText(initialValue));
  const [isDirty, setIsDirty] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const advancedEditor = useMemo(
    () => resolveAdvancedCellEditor(column),
    [column],
  );
  const usesPopover = advancedEditor?.presentation === "popover";
  const usesDialog = advancedEditor?.presentation === "dialog";

  useEffect(() => {
    setValue(valueToInputText(initialValue));
    setIsDirty(false);
    skipBlurCommitRef.current = false;
  }, [initialValue]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (!isActive && dialogOpen) {
      setDialogOpen(false);
    }
  }, [dialogOpen, isActive]);

  const commit = (nextValue: unknown) => {
    skipBlurCommitRef.current = true;
    onCommit?.(rowIndex, columnId, nextValue);
  };

  const closeDialogWithoutCommit = () => {
    setDialogOpen(false);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const formatJsonValue = (nextValue: string): string | null => {
    const formatted = formatJsonEditorValue(nextValue);
    if (formatted == null) {
      toast.error("JSON 格式无效");
    }
    return formatted;
  };

  const inputControl = (
    <div className="relative w-full">
      <Input
        ref={inputRef}
        className={cn(
          "h-7 rounded-sm px-2 text-xs",
          advancedEditor && "pr-8",
        )}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setIsDirty(true);
        }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onBlur={() => {
          if (skipBlurCommitRef.current || popoverOpen || dialogOpen) {
            skipBlurCommitRef.current = false;
            return;
          }
          if (isDirty) {
            onCommit?.(rowIndex, columnId, value);
            return;
          }
          onCancel?.();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            skipBlurCommitRef.current = true;
            onCancel?.();
          }
        }}
      />
      {advancedEditor && column && usesPopover && (
        <PopoverTrigger
          render={<Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute top-0.5 right-0.5 size-6"
            title={`打开${advancedEditor.title}编辑器`}
            aria-label={`打开${advancedEditor.title}编辑器`}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              skipBlurCommitRef.current = true;
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal data-icon="inline-end" />
          </Button>}
        />
      )}
      {advancedEditor && column && usesDialog && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute top-0.5 right-0.5 size-6"
          title={`打开${advancedEditor.title}编辑器`}
          aria-label={`打开${advancedEditor.title}编辑器`}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            skipBlurCommitRef.current = true;
          }}
          onClick={(event) => {
            event.stopPropagation();
            setDialogOpen(true);
          }}
        >
          <MoreHorizontal data-icon="inline-end" />
        </Button>
      )}
    </div>
  );

  if (usesPopover) {
    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        {inputControl}
        {advancedEditor && column && (
          <AdvancedCellEditorPopover
            column={column}
            config={advancedEditor}
            value={value}
            onApply={(nextValue) => {
              setPopoverOpen(false);
              commit(nextValue);
            }}
          />
        )}
      </Popover>
    );
  }

  return (
    <>
      {inputControl}
      {advancedEditor && column && usesDialog && isActive && (
        <CodeEditorDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (open) {
              setDialogOpen(true);
              return;
            }
            closeDialogWithoutCommit();
          }}
          title={advancedEditor.title}
          description={column.header}
          value={value}
          language={advancedEditor.kind === "json" ? "json" : "plaintext"}
          preset={advancedEditor.kind === "json" ? "jsonDocument" : "default"}
          editorPath={`datatable-cell-${rowIndex}-${columnId}-${advancedEditor.kind}`}
          validate={
            advancedEditor.kind === "json" ? validateJsonEditorValue : undefined
          }
          toolbarActions={
            advancedEditor.kind === "json"
              ? ({ draftValue, setDraftValue }) => (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const formatted = formatJsonValue(draftValue);
                      if (formatted != null) setDraftValue(formatted);
                    }}
                  >
                    <Braces data-icon="inline-start" />
                    格式化
                  </Button>
                )
              : undefined
          }
          onApply={(nextValue) => {
            setDialogOpen(false);
            setValue(nextValue);
            setIsDirty(false);
            commit(nextValue);
          }}
        />
      )}
    </>
  );
}
