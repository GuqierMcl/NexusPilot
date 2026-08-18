export function valueToInputText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function valueToDateInput(value: unknown): string {
  const text = valueToInputText(value).trim();
  return text.slice(0, 10);
}

export function valueToTimeInput(value: unknown): string {
  const text = valueToInputText(value).trim();
  const [hour = "00", minute = "00", second = "00"] = text.split(":");
  return [hour, minute, second]
    .map((part) => {
      const number = Number(part);
      if (!Number.isInteger(number) || number < 0) return "00";
      return number.toString().padStart(2, "0");
    })
    .join(":")
    .slice(0, 8);
}

export function valueToDateTimeInput(value: unknown): string {
  const text = valueToInputText(value).trim().replace("T", " ");
  const [date = "", time = ""] = text.split(/\s+/, 2);
  if (!date) return "";
  return `${date.slice(0, 10)} ${valueToTimeInput(time)}`;
}

export function dateTimeInputToDatabaseText(value: string): string {
  return value.replace("T", " ");
}
