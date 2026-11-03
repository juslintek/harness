import type { Database } from "bun:sqlite";
import { getMember, getOrg, listPositions, listProjects, listTeams } from "../orgs/api";
import { explain } from "../policies/api";
import { profileOfMember } from "../profiles/api";
import { answersOf, questionsOf } from "./interview-repo";
import type { HireHead } from "./repo";
import { candidatesOf, teamMemberIds } from "./repo";

const MAX_CHARS = 6000;

function managerHandle(db: Database, orgId: string, memberId: string): string | null {
  const positions = listPositions(db, orgId);
  const parent = positions.find((p) => p.memberId === memberId)?.reportsTo;
  const holder = positions.find((p) => p.id === parent)?.memberId;
  return holder ? (getMember(db, holder)?.handle ?? null) : null;
}

function teammates(db: Database, request: HireHead, memberId: string): string[] {
  return teamMemberIds(db, request.teamId).flatMap((id) => {
    const m = id === memberId ? null : getMember(db, id);
    if (!m) return [];
    const summary = profileOfMember(db, id)?.card?.summary;
    return [`- @${m.handle} (${m.displayName})${summary ? `: ${summary}` : ""}`];
  });
}

function interviewSection(db: Database, request: HireHead, memberId: string): string[] {
  const profileId = profileOfMember(db, memberId)?.id;
  const mine = candidatesOf(db, request.id).find((c) => c.profileId === profileId);
  if (!mine) return [];
  const questions = new Map(questionsOf(db, request.id).map((q) => [q.id, q.body]));
  return answersOf(db, mine.id).map(
    (a) => `- Q: ${questions.get(a.questionId) ?? ""}\n  A: ${a.body}`,
  );
}

// The answers come last and are cut first when the pack is too long, since they are the least actionable part.
export function onboardingPack(db: Database, memberId: string, request: HireHead): string {
  const org = getOrg(db, request.orgId);
  const team = listTeams(db, request.orgId).find((t) => t.id === request.teamId);
  const manager = managerHandle(db, request.orgId, memberId);
  const projects = listProjects(db, request.orgId).filter((p) => p.teamId === request.teamId);
  const policies = explain(db, { orgId: request.orgId, teamId: request.teamId, memberId });
  const { spec } = request;
  const lines = [
    `# Welcome to ${org?.name ?? "the org"}, team ${team?.name ?? ""}`,
    "",
    `You are the ${spec.title}. ${spec.summary}`,
    spec.mustHave.length > 0 ? `Must have: ${spec.mustHave.join(", ")}.` : "",
    `Task types: ${spec.taskTypes.join(", ")}.`,
    "",
    manager ? `You report to @${manager}.` : "You report to the team's human admins.",
    "",
    "## Teammates",
    ...teammates(db, request, memberId),
    "",
    "## Team projects",
    ...projects.map((p) => `- ${p.key}: ${p.name}${p.repo ? ` (${p.repo})` : ""}`),
    "",
    "## Policies",
    ...policies.map((p) => `- ${p.key}: ${JSON.stringify(p.value)} (${p.layer})`),
    "",
    `Use the harness MCP tools; ask ${manager ? `@${manager}` : "a human admin"} when blocked.`,
    "",
    "## Your interview",
    ...interviewSection(db, request, memberId),
  ];
  return lines.join("\n").slice(0, MAX_CHARS);
}
