import type { NoteScope, NoteType } from "../../../shared/memory";
import type { LayaQuestion, LayaResult } from "./client";
import {
  decide as decideImpl,
  layaHealth as layaHealthImpl,
  resetLayaCircuit as resetImpl,
} from "./client";
import type { NoteClass } from "./note";
import { classifyNote as classifyNoteImpl } from "./note";
import type { TaskTriage } from "./task";
import { triageTask as triageTaskImpl } from "./task";
import type { WakeTriage } from "./wake";
import { triageWake as triageWakeImpl } from "./wake";

export type { Specialty } from "../../../shared/router";
export type { LayaAnswer, LayaQuestion, LayaResult } from "./client";
export type { NoteClass } from "./note";
export type { TaskTriage } from "./task";

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

export function triageTask(text: string): Promise<TaskTriage> {
  return triageTaskImpl(text);
}

export function classifyNote(
  text: string,
  allowed: NoteScope[],
  hint?: NoteType,
): Promise<NoteClass> {
  return classifyNoteImpl(text, allowed, hint);
}
