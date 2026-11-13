export function fmtTime(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toLocaleString();
}

export function fmtDuration(start: number | null, end: number | null): string {
  if (start === null) return "-";
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// "Today 14:11", or the date for an older run, so a list of runs reads without a year.
export function fmtStarted(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  const at = new Date(ms);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.toDateString() === new Date().toDateString()) return `Today ${time}`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export const fmtCost = (usd: number | null | undefined): string | undefined =>
  usd === null || usd === undefined ? undefined : `$${usd.toFixed(2)}`;
