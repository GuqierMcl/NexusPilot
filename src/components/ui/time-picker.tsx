"use client"

import * as React from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

const HOURS = Array.from({ length: 24 }, (_, index) =>
  index.toString().padStart(2, "0"),
)
const MINUTES = Array.from({ length: 60 }, (_, index) =>
  index.toString().padStart(2, "0"),
)
const SECONDS = MINUTES

function normalizeTimePart(value: string | undefined, fallback: string): string {
  if (!value || !/^\d{1,2}$/.test(value)) return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) return fallback
  return number.toString().padStart(2, "0")
}

function parseTimeValue(value: string | undefined): [string, string, string] {
  const [hour, minute, second] = (value ?? "").trim().split(":")
  const normalizedHour = normalizeTimePart(hour, "00")
  const normalizedMinute = normalizeTimePart(minute, "00")
  const normalizedSecond = normalizeTimePart(second, "00")

  return [
    HOURS.includes(normalizedHour) ? normalizedHour : "00",
    MINUTES.includes(normalizedMinute) ? normalizedMinute : "00",
    SECONDS.includes(normalizedSecond) ? normalizedSecond : "00",
  ]
}

function joinTimeValue(hour: string, minute: string, second: string): string {
  return `${hour}:${minute}:${second}`
}

interface TimePickerProps {
  value?: string
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
}

function TimePicker({
  value,
  onValueChange,
  disabled,
  className,
}: TimePickerProps) {
  const [hour, minute, second] = React.useMemo(
    () => parseTimeValue(value),
    [value],
  )

  const handlePartChange = React.useCallback(
    (part: "hour" | "minute" | "second", nextValue: string) => {
      const nextHour = part === "hour" ? nextValue : hour
      const nextMinute = part === "minute" ? nextValue : minute
      const nextSecond = part === "second" ? nextValue : second
      onValueChange(joinTimeValue(nextHour, nextMinute, nextSecond))
    },
    [hour, minute, onValueChange, second],
  )

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <TimePartSelect
        ariaLabel="选择小时"
        disabled={disabled}
        options={HOURS}
        value={hour}
        onValueChange={(nextValue) => handlePartChange("hour", nextValue)}
      />
      <span className="text-muted-foreground">:</span>
      <TimePartSelect
        ariaLabel="选择分钟"
        disabled={disabled}
        options={MINUTES}
        value={minute}
        onValueChange={(nextValue) => handlePartChange("minute", nextValue)}
      />
      <span className="text-muted-foreground">:</span>
      <TimePartSelect
        ariaLabel="选择秒"
        disabled={disabled}
        options={SECONDS}
        value={second}
        onValueChange={(nextValue) => handlePartChange("second", nextValue)}
      />
    </div>
  )
}

interface TimePartSelectProps {
  ariaLabel: string
  disabled?: boolean
  options: string[]
  value: string
  onValueChange: (value: string) => void
}

function TimePartSelect({
  ariaLabel,
  disabled,
  options,
  value,
  onValueChange,
}: TimePartSelectProps) {
  return (
    <Select value={value} onValueChange={(nextValue) => {
      if (nextValue != null) onValueChange(nextValue)
    }} disabled={disabled}>
      <SelectTrigger size="sm" className="w-16" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

export { TimePicker, parseTimeValue, joinTimeValue }
