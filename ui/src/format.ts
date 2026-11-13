export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// "11 Nov 10:42:07": the day and month are enough for a log, the year is the same for most rows.
export function shortStamp(ms: number): string {
  const at = new Date(ms);
  return `${at.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${at.toLocaleTimeString("en-GB")}`;
}

// "Nov 11, 09:40": when a request was filed, to the minute.
export function filedStamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// "2026-11-10 14:02": a record's own date and time, same on every screen that lists them.
export function minuteStamp(ms: number | string): string {
  const at = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
