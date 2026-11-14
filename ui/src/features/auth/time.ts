import { minuteStamp } from "../../format";

export function fmtTime(ms: number | null): string {
  return ms === null ? "-" : minuteStamp(ms);
}
