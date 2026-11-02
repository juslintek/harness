export function fmtTime(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toLocaleString();
}

export function fmtDuration(start: number | null, end: number | null): string {
  if (start === null) return "-";
  const seconds = Math.max(0, Math.round(((end ?? Date.now()) - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
