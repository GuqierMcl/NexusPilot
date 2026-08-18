import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DatePickerCalendar,
  DateTimePicker,
  formatDateValue,
  parseDateValue,
} from "@/components/ui/date-time-picker";
import {
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from "@/components/ui/popover";
import { TimePicker } from "@/components/ui/time-picker";
import type { DataTableColumn } from "../types";
import type { AdvancedCellEditorConfig } from "./editor-registry";
import {
  valueToDateInput,
  valueToDateTimeInput,
  valueToTimeInput,
} from "./value-format";

function formatTimeValue(date: Date): string {
  return [
    date.getHours().toString().padStart(2, "0"),
    date.getMinutes().toString().padStart(2, "0"),
    date.getSeconds().toString().padStart(2, "0"),
  ].join(":");
}

interface AdvancedCellEditorPopoverProps {
  column: DataTableColumn;
  config: AdvancedCellEditorConfig;
  value: unknown;
  onApply: (value: unknown) => void;
}

export function AdvancedCellEditorPopover({
  column,
  config,
  value,
  onApply,
}: AdvancedCellEditorPopoverProps) {
  const [dateValue, setDateValue] = useState(() => valueToDateInput(value));
  const [timeValue, setTimeValue] = useState(() => valueToTimeInput(value));
  const [dateTimeValue, setDateTimeValue] = useState(() =>
    valueToDateTimeInput(value).replace("T", " "),
  );

  useEffect(() => {
    setDateValue(valueToDateInput(value));
    setTimeValue(valueToTimeInput(value));
    setDateTimeValue(valueToDateTimeInput(value).replace("T", " "));
  }, [value]);

  const nullable = column.nullable !== false;

  return (
    <PopoverContent
      align="end"
      className="w-80"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      initialFocus={false}
    >
      <PopoverHeader>
        <PopoverTitle>{config.title}</PopoverTitle>
        <PopoverDescription>{column.header}</PopoverDescription>
      </PopoverHeader>

      {config.kind === "boolean" && (
        <div className="flex flex-col gap-2">
          <Button size="sm" variant="outline" onClick={() => onApply(true)}>
            true
          </Button>
          <Button size="sm" variant="outline" onClick={() => onApply(false)}>
            false
          </Button>
          {nullable && (
            <Button size="sm" variant="ghost" onClick={() => onApply(null)}>
              NULL
            </Button>
          )}
        </div>
      )}

      {config.kind === "enum" && (
        <div className="flex max-h-64 flex-col gap-1 overflow-auto">
          {column.enumValues?.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => onApply(option)}
            >
              {option}
            </Button>
          ))}
          {nullable && (
            <Button
              size="sm"
              variant="ghost"
              className="justify-start text-muted-foreground"
              onClick={() => onApply(null)}
            >
              NULL
            </Button>
          )}
        </div>
      )}

      {config.kind === "date" && (
        <div className="flex flex-col gap-2">
          <DatePickerCalendar
            selected={parseDateValue(dateValue)}
            onSelect={(date) => {
              if (date) setDateValue(formatDateValue(date));
            }}
            onDateSelectIntent={(date, modifiers) => {
              if (!modifiers.disabled) setDateValue(formatDateValue(date));
            }}
          />
          <div className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            当前选择：{dateValue || "未选择"}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDateValue(formatDateValue(new Date()))}
            >
              今天
            </Button>
            <Button size="sm" onClick={() => onApply(dateValue)}>
              应用
            </Button>
          </div>
        </div>
      )}

      {config.kind === "time" && (
        <div className="flex flex-col gap-2">
          <TimePicker value={timeValue} onValueChange={setTimeValue} />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTimeValue(formatTimeValue(new Date()))}
            >
              现在
            </Button>
            <Button size="sm" onClick={() => onApply(timeValue)}>
              应用
            </Button>
          </div>
        </div>
      )}

      {config.kind === "datetime" && (
        <div className="flex flex-col gap-2">
          <DateTimePicker
            value={dateTimeValue}
            onValueChange={setDateTimeValue}
          />
          <div className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            当前选择：{dateTimeValue || "未选择"}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const timePart = dateTimeValue.trim().split(/\s+/, 2)[1] ?? "00:00:00";
                setDateTimeValue(`${formatDateValue(new Date())} ${timePart}`);
              }}
            >
              今天
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const now = new Date();
                setDateTimeValue(`${formatDateValue(now)} ${formatTimeValue(now)}`);
              }}
            >
              现在
            </Button>
            <Button size="sm" onClick={() => onApply(dateTimeValue)}>
              应用
            </Button>
          </div>
        </div>
      )}
    </PopoverContent>
  );
}
