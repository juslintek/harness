export function fmtTime(ms: number | null): string {
  return ms === null ? "-" : new Date(ms).toLocaleString();
}
