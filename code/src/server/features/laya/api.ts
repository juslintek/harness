import type { LayaQuestion, LayaResult } from "./client";
import {
  decide as decideImpl,
  layaHealth as layaHealthImpl,
  resetLayaCircuit as resetImpl,
} from "./client";
import type { WakeTriage } from "./wake";
import { triageWake as triageWakeImpl } from "./wake";

export type { LayaAnswer, LayaQuestion, LayaResult } from "./client";
export type { Specialty } from "./wake";

export function decide(
  state: unknown,
  questions: Record<string, LayaQuestion>,
  timeoutMs: number,
): Promise<LayaResult> {
  return decideImpl(state, questions, timeoutMs);
}

export function layaHealth(): Promise<{ up: boolean; version: string | null }> {
  return layaHealthImpl();
}

export function resetLayaCircuit(): void {
  resetImpl();
}

export function triageWake(text: string): Promise<WakeTriage> {
  return triageWakeImpl(text);
}
