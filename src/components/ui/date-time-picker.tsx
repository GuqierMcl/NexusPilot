"use client"

import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { Modifiers } from "react-day-picker"

import { Calendar } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TimePicker, parseTimeValue } from "@/components/ui/time-picker"
import { cn } from "@/lib/utils"

const DATE_PICKER_START_YEAR = 1900
const DATE_PICKER_END_YEAR = 2100
const DATE_PICKER_MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: String(index),
  label: `${index + 1}月`,
}))
const DATE_PICKER_YEAR_OPTIONS = Array.from(
  { length: DATE_PICKER_END_YEAR - DATE_PICKER_START_YEAR + 1 },
  (_, index) => {
    const year = DATE_PICKER_START_YEAR + index
    return { value: String(year), label: `${year}年` }
  },
)

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

function formatDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseDateValue(value: string | undefined): Date | undefined {
  const match = (value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return undefined

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined

  const date = new Date(year, month - 1, day)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined
  }

  return date
}

function todayDateValue(): string {
  return formatDateValue(new Date())
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function dateTimeToParts(value: string | undefined): {
  dateValue: string
  timeValue: string
} {
  const text = (value ?? "").trim().replace("T", " ")
  const [datePart, timePart] = text.split(/\s+/, 2)
  const dateValue = parseDateValue(datePart) ? datePart.slice(0, 10) : todayDateValue()
  const [hour, minute, second] = parseTimeValue(timePart)

  return {
    dateValue,
    timeValue: `${hour}:${minute}:${second}`,
  }
}

interface DateTimePickerProps {
  value?: string
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
}

interface DatePickerCalendarProps {
  selected?: Date
  disabled?: boolean
  onSelect?: (date: Date | undefined) => void
  onDateSelectIntent?: (date: Date, modifiers: Modifiers) => void
}

function DatePickerCalendar({
  selected,
  disabled,
  onSelect,
  onDateSelectIntent,
}: DatePickerCalendarProps) {
  const selectedTimestamp = selected?.getTime()
  const [month, setMonth] = React.useState(() =>
    startOfMonth(selected ?? new Date()),
  )

  React.useEffect(() => {
    if (selectedTimestamp !== undefined) {
      setMonth(startOfMonth(new Date(selectedTimestamp)))
    }
  }, [selectedTimestamp])

  const earliestMonth = new Date(DATE_PICKER_START_YEAR, 0, 1)
  const latestMonth = new Date(DATE_PICKER_END_YEAR, 11, 1)
  const canGoToPreviousMonth = month > earliestMonth
  const canGoToNextMonth = month < latestMonth

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="上一个月"
          disabled={disabled || !canGoToPreviousMonth}
          onClick={() =>
            setMonth(
              (current) =>
                new Date(current.getFullYear(), current.getMonth() - 1, 1),
            )
          }
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex items-center gap-1">
          <Select
            value={String(month.getMonth())}
            items={DATE_PICKER_MONTH_OPTIONS}
            disabled={disabled}
            onValueChange={(value) => {
              if (value == null) return
              const nextMonth = Number(value)
              if (!Number.isInteger(nextMonth)) return
              setMonth(
                (current) => new Date(current.getFullYear(), nextMonth, 1),
              )
            }}
          >
            <SelectTrigger size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PICKER_MONTH_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={String(month.getFullYear())}
            items={DATE_PICKER_YEAR_OPTIONS}
            disabled={disabled}
            onValueChange={(value) => {
              if (value == null) return
              const nextYear = Number(value)
              if (!Number.isInteger(nextYear)) return
              setMonth(
                (current) => new Date(nextYear, current.getMonth(), 1),
              )
            }}
          >
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PICKER_YEAR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="下一个月"
          disabled={disabled || !canGoToNextMonth}
          onClick={() =>
            setMonth(
              (current) =>
                new Date(current.getFullYear(), current.getMonth() + 1, 1),
            )
          }
        >
          <ChevronRightIcon />
        </Button>
      </div>
      <Calendar
        mode="single"
        month={month}
        hideNavigation
        selected={selected}
        disabled={disabled}
        onMonthChange={setMonth}
        onSelect={onSelect}
        onDateSelectIntent={onDateSelectIntent}
      />
    </div>
  )
}

function DateTimePicker({
  value,
  onValueChange,
  disabled,
  className,
}: DateTimePickerProps) {
  const { dateValue, timeValue } = React.useMemo(
    () => dateTimeToParts(value),
    [value],
  )
  const selectedDate = React.useMemo(() => parseDateValue(dateValue), [dateValue])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <DatePickerCalendar
        selected={selectedDate}
        disabled={disabled}
        onSelect={(date) => {
          if (!date) return
          onValueChange(`${formatDateValue(date)} ${timeValue}`)
        }}
        onDateSelectIntent={(date, modifiers) => {
          if (modifiers.disabled) return
          onValueChange(`${formatDateValue(date)} ${timeValue}`)
        }}
      />
      <TimePicker
        value={timeValue}
        disabled={disabled}
        onValueChange={(nextTime) => {
          onValueChange(`${dateValue} ${nextTime}`)
        }}
      />
    </div>
  )
}

export {
  DatePickerCalendar,
  DateTimePicker,
  dateTimeToParts,
  formatDateValue,
  parseDateValue,
}
