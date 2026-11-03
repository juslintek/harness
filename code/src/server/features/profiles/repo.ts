import type { Database } from "bun:sqlite";
import {
  type ProfileInput,
  type ProfilePatch,
  type ProfileView,
  type SelfCard,
  selfCardSchema,
} from "../../../shared/profiles";

interface ProfileRow {
  id: string;
  org_id: string;
  runtime: string;
  model: string | null;
  persona: string;
  skills: string;
  scope: string;
  fallbacks: string;
  card: string | null;
  card_at: number | null;
}

const view = (r: ProfileRow): ProfileView => ({
  id: r.id,
  orgId: r.org_id,
  runtime: r.runtime,
  model: r.model,
  persona: r.persona,
  skills: JSON.parse(r.skills),
  scope: JSON.parse(r.scope),
  fallbacks: JSON.parse(r.fallbacks),
  card: r.card === null ? null : selfCardSchema.parse(JSON.parse(r.card)),
  cardAt: r.card_at,
});

export function getProfile(db: Database, id: string): ProfileView | null {
  const row = db.query<ProfileRow, [string]>("SELECT * FROM profiles WHERE id = ?").get(id);
  return row ? view(row) : null;
}

export function createProfile(db: Database, orgId: string, input: ProfileInput): ProfileView {
  const id = Bun.randomUUIDv7();
  const now = Date.now();
  db.query(
    `INSERT INTO profiles (id, org_id, runtime, model, persona, skills, scope, fallbacks, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    orgId,
    input.runtime,
    input.model,
    input.persona,
    JSON.stringify(input.skills),
    JSON.stringify(input.scope),
    JSON.stringify(input.fallbacks),
    now,
    now,
  );
  return getProfile(db, id) as ProfileView;
}

// The member row is what the runner reads, so a changed engine has to reach it too.
export function updateProfile(db: Database, id: string, patch: ProfilePatch): ProfileView {
  const cur = getProfile(db, id);
  if (!cur) throw new Error("unknown profile");
  const next = {
    runtime: patch.runtime ?? cur.runtime,
    model: patch.model === undefined ? cur.model : patch.model,
    persona: patch.persona ?? cur.persona,
    skills: patch.skills ?? cur.skills,
    scope: patch.scope ?? cur.scope,
    fallbacks: patch.fallbacks ?? cur.fallbacks,
  };
  db.transaction(() => {
    db.query(
      `UPDATE profiles SET runtime = ?, model = ?, persona = ?, skills = ?, scope = ?, fallbacks = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.runtime,
      next.model,
      next.persona,
      JSON.stringify(next.skills),
      JSON.stringify(next.scope),
      JSON.stringify(next.fallbacks),
      Date.now(),
      id,
    );
    db.query("UPDATE members SET agent_id = ?, model = ? WHERE profile_id = ?").run(
      next.runtime,
      next.model,
      id,
    );
  })();
  return getProfile(db, id) as ProfileView;
}

export function profileOfMember(db: Database, memberId: string): ProfileView | null {
  const row = db
    .query<ProfileRow, [string]>(
      "SELECT p.* FROM profiles p JOIN members m ON m.profile_id = p.id WHERE m.id = ?",
    )
    .get(memberId);
  return row ? view(row) : null;
}

export function attachProfile(db: Database, memberId: string, profileId: string): void {
  const profile = getProfile(db, profileId);
  const changed = profile
    ? db
        .query(
          "UPDATE members SET profile_id = ?, agent_id = ?, model = ? WHERE id = ? AND kind = 'agent' AND org_id = ?",
        )
        .run(profileId, profile.runtime, profile.model, memberId, profile.orgId).changes
    : 0;
  if (changed === 0) throw new Error("profile and agent member must belong to the same org");
}

// Also keeps members.specialties in step so Laya mention matching reads the card's labels.
export function storeCard(db: Database, profileId: string, card: SelfCard): void {
  const now = Date.now();
  db.transaction(() => {
    db.query("UPDATE profiles SET card = ?, card_at = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(card),
      now,
      now,
      profileId,
    );
    db.query("UPDATE members SET specialties = ? WHERE profile_id = ?").run(
      JSON.stringify(card.specialties),
      profileId,
    );
  })();
}

export interface AgentMemberRow {
  agentId: string;
  model: string | null;
  orgId: string;
  profileId: string | null;
}

export function agentOf(db: Database, memberId: string): AgentMemberRow | null {
  const row = db
    .query<
      { agent_id: string; model: string | null; org_id: string; profile_id: string | null },
      [string]
    >("SELECT agent_id, model, org_id, profile_id FROM members WHERE id = ? AND kind = 'agent'")
    .get(memberId);
  return row
    ? { agentId: row.agent_id, model: row.model, orgId: row.org_id, profileId: row.profile_id }
    : null;
}
