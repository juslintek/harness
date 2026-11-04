import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { updateTask } from "../board/api";
import { agentViewer, createNote, projectSlugs, resolveNotePath } from "../memory/api";
import { setup, specFor, until } from "./kit";

setDefaultTimeout(30_000);

async function seed(k: ReturnType<typeof setup>, memberId: string): Promise<void> {
  const viewer = agentViewer(k.db, memberId);
  const loc = resolveNotePath(
    "/memories/project/web/deploy.md",
    viewer,
    projectSlugs(k.db, k.orgId),
  );
  if (loc === null || loc === "dir") throw new Error("bad path");
  await createNote(
    k.db,
    k.home,
    { viewer, runId: null },
    loc,
    "# Deploy checklist\nrun migrations before the staging deploy",
  );
}

async function runWith(mcp: boolean): Promise<{
  prompt: string;
  env: Record<string, string>;
  file: string | null;
  mode: number | null;
}> {
  const k = setup();
  const bob = k.agent("bob");
  await seed(k, bob.id);
  k.runDeps.resolveSpec = () => ({ ...specFor("fake"), mcp });
  const lane = k.runDeps.lane as NonNullable<typeof k.runDeps.lane>;
  const out = {
    prompt: "",
    env: {} as Record<string, string>,
    file: null as string | null,
    mode: null as number | null,
  };
  k.runDeps.lane = (ctx) => {
    out.prompt = ctx.prompt;
    out.env = ctx.env;
    const path = ctx.env.HARNESS_MEMORY_FILE;
    if (path !== undefined) {
      out.file = readFileSync(path, "utf8");
      out.mode = statSync(path).mode & 0o777;
    }
    return lane(ctx);
  };
  const stop = k.start();
  updateTask(k.db, k.task("Deploy staging").id, { assigneeId: bob.id }, k.human.id);
  await until(() => out.prompt !== "");
  await stop();
  return out;
}

test("an engine without MCP gets MEMORY.md (0600) in its run dir and the file line in its prompt", async () => {
  const r = await runWith(false);
  expect(r.prompt).toContain("$HARNESS_MEMORY_FILE");
  expect(r.prompt).not.toContain("the `memory` tool");
  expect(r.env.HARNESS_MEMORY_FILE).toEndWith("MEMORY.md");
  expect(r.file).toContain("## Deploy checklist\n/memories/project/web/deploy.md");
  expect(r.file).toContain("run migrations before the staging deploy");
  expect(r.mode).toBe(0o600);
});

test("an engine with MCP gets the tool line and hints and no file", async () => {
  const r = await runWith(true);
  expect(r.prompt).toContain("the `memory` tool");
  expect(r.prompt).toContain("/memories/project/web/deploy.md");
  expect(r.prompt).not.toContain("run migrations");
  expect(r.env.HARNESS_MEMORY_FILE).toBeUndefined();
});
