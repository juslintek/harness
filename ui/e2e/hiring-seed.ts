import type { Page } from "@playwright/test";
import type { Stack } from "./stack";

export interface Seeded {
  orgId: string;
  meId: string;
  teamId: string;
  ids: { scoring: string; deciding: string; rejecting: string; hired: string };
}

// Filing a hire needs a ready runtime and starts real interviews, so requests are written straight
// to the database in the phases the screens depend on.
export async function seedHires(page: Page, stack: Stack): Promise<Seeded> {
  const { orgId, meId, teamId } = await page.evaluate(async () => {
    const call = async <T>(path: string, body?: unknown): Promise<T> => {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const team = await call<{ id: string }>("/api/orgs/acme/teams", { name: "Platform" });
    const org = await call<{ org: { id: string }; me: { id: string } }>("/api/orgs/acme");
    return { orgId: org.org.id, meId: org.me.id, teamId: team.id };
  });
  const now = Date.now();
  const spec = (title: string): string =>
    JSON.stringify({
      title,
      specialty: "backend",
      summary: `Owns the ${title.toLowerCase()} work.`,
      mustHave: ["Postgres migrations"],
      taskTypes: ["feature", "bugfix"],
    });
  const card = JSON.stringify({
    summary: "Backend generalist, strongest on queues and SQL.",
    specialties: ["backend", "database"],
    strengths: ["migrations"],
    limits: ["no frontend work"],
    preferredTaskTypes: ["feature"],
  });
  const profile = (id: string, runtime: string, model: string, withCard: boolean): void =>
    stack.sql(
      "INSERT INTO profiles (id, org_id, runtime, model, scope, card, card_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      orgId,
      runtime,
      model,
      '{"readOnly":true}',
      withCard ? card : (null as never),
      withCard ? now : (null as never),
      now,
      now,
    );
  const hire = (id: string, title: string, status: string, ago: number): void =>
    stack.sql(
      "INSERT INTO hire_requests (id, org_id, team_id, requested_by, spec, status, phase_started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      orgId,
      teamId,
      meId,
      spec(title),
      status,
      now - ago,
      now - ago,
      now - ago,
    );
  const candidate = (id: string, request: string, profileId: string, status: string): void =>
    stack.sql(
      "INSERT INTO hire_candidates (id, request_id, profile_id, status, system_score) VALUES (?, ?, ?, ?, ?)",
      id,
      request,
      profileId,
      status,
      8.4,
    );

  profile("pf1", "claude", "opus", true);
  profile("pf2", "codex", "gpt-5", false);
  profile("pf3", "claude", "sonnet", true);
  profile("pf4", "claude", "haiku", true);
  profile("pf5", "codex", "gpt-5", true);

  hire("hr-scoring", "Backend engineer", "scoring", 1000);
  candidate("cd1", "hr-scoring", "pf1", "answered");
  candidate("cd2", "hr-scoring", "pf2", "answered");
  stack.sql(
    "INSERT INTO interview_questions (id, request_id, candidate_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    "q1",
    "hr-scoring",
    null as never,
    "base",
    "Which part of the queue would you change first?",
    now,
  );
  stack.sql(
    "INSERT INTO interview_answers (question_id, candidate_id, body, created_at) VALUES (?, ?, ?, ?)",
    "q1",
    "cd1",
    "The retry policy.",
    now,
  );
  stack.sql(
    "INSERT INTO scorecards (candidate_id, scorer_id, fit, depth, honesty, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    "cd2",
    meId,
    4,
    3,
    5,
    "clear about limits",
    now,
  );

  hire("hr-deciding", "Release reviewer", "deciding", 2000);
  candidate("cd3", "hr-deciding", "pf3", "answered");
  candidate("cd4", "hr-deciding", "pf4", "answered");

  hire("hr-rejecting", "Docs writer", "deciding", 3000);
  candidate("cd5", "hr-rejecting", "pf5", "answered");

  hire("hr-hired", "Mobile engineer", "hired", 4000);
  return {
    orgId,
    meId,
    teamId,
    ids: {
      scoring: "hr-scoring",
      deciding: "hr-deciding",
      rejecting: "hr-rejecting",
      hired: "hr-hired",
    },
  };
}
