import type { Database } from "bun:sqlite";
import { type ProfileView, type SelfCard, selfCardSchema } from "../../../shared/profiles";
import { DomainError } from "../../route-kit";
import {
  agentOf,
  attachProfile,
  createProfile,
  getProfile,
  profileOfMember,
  storeCard,
  updateProfile,
} from "./repo";

export { attachProfile, createProfile, getProfile, profileOfMember, updateProfile };

export type CardResult = { ok: true; card: SelfCard } | { ok: false; issues: string[] };

export function submitCard(db: Database, profileId: string, raw: unknown): CardResult {
  if (!getProfile(db, profileId)) throw new Error("unknown profile");
  const parsed = selfCardSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "card"}: ${i.message}`),
    };
  }
  storeCard(db, profileId, parsed.data);
  return { ok: true, card: parsed.data };
}

// Agents created before profiles existed only have agent_id and model on the member row.
export function ensureProfile(db: Database, memberId: string): ProfileView {
  const agent = agentOf(db, memberId);
  if (!agent) throw new DomainError("not an agent member");
  const existing = agent.profileId ? getProfile(db, agent.profileId) : null;
  if (existing) return existing;
  const profile = createProfile(db, agent.orgId, {
    runtime: agent.agentId,
    model: agent.model,
    persona: "",
    skills: [],
    scope: { readOnly: false },
    fallbacks: [],
  });
  attachProfile(db, memberId, profile.id);
  return profile;
}
