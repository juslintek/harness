import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";
import type { Stack } from "./stack";

const ADMIN = {
  email: "ada@acme.example",
  name: "Ada",
  admin: true,
};

async function call(page: Page, method: string, path: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async (req) => {
      const res = await fetch(req.path, {
        method: req.method,
        headers: { "content-type": "application/json" },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });
      if (!res.ok) throw new Error(`${req.method} ${req.path}: HTTP ${res.status}`);
      return res.json();
    },
    { method, path, body },
  );
}

const SHOTS = process.env.SHOTS_DIR;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [w, h] of [
    [1440, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `${SHOTS}/${name}-${w}-light.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `${SHOTS}/${name}-375-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: "light" });
}

async function noPageScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toBeHidden();
}

// An org with a project and one agent, so the page shows its blocks and not the setup steps.
async function staffedOrg(page: Page, stack: Stack): Promise<string> {
  await call(page, "POST", "/api/orgs/personal/projects", { key: "HRN", name: "Harness" });
  const org = (await call(page, "GET", "/api/orgs/personal")) as { org: { id: string } };
  stack.sql(
    "INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m-bot', ?, 'agent', 'bot-agent', 'bot', 'Bot', 'member', 1)",
    org.org.id,
  );
  return org.org.id;
}

function seedApproval(stack: Stack, id: string, command: string, runId: string): void {
  const now = Date.now();
  stack.sql(
    "INSERT INTO approvals (id, run_id, action, l1, status, decided_by, created_at, expires_at, decided_at) VALUES (?, ?, ?, '{}', 'pending', '', ?, ?, 0)",
    id,
    runId,
    JSON.stringify({ command }),
    now - 1000,
    now + 300_000,
  );
}

function seedRun(stack: Stack, id: string, orgId: string, state: string, ended: boolean): void {
  const now = Date.now();
  stack.sql(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, reason, created_at, started_at, ended_at, member_id, org_id) VALUES (?, 'bot-agent', '/tmp/x', 'work', ?, ?, ?, ?, ?, 'm-bot', ?)",
    id,
    state,
    ended ? "rate_limited" : "",
    now - 600_000,
    now - 600_000,
    ended ? now - 60_000 : 0,
    orgId,
  );
}

test("a fresh org shows the setup steps, each with its link", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/now");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set up Personal" })).toBeVisible();
  const steps = page.getByRole("list", { name: "Setup steps" });
  await expect(steps.getByRole("listitem")).toHaveCount(6);
  await expect(steps.getByRole("link", { name: "Start hiring" })).toHaveAttribute(
    "href",
    "#/o/personal/hiring",
  );
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
  await noPageScroll(page);
});

test("a quiet org says nothing is running and offers the board and chat", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await staffedOrg(page, stack);
  await page.goto("/#/now");
  await page.reload();
  await expect(page.getByText("Nothing is running", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Needs you" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open board" })).toHaveAttribute(
    "href",
    "#/o/personal/board",
  );
  await expect(page.getByRole("link", { name: "Open chat" })).toHaveAttribute(
    "href",
    "#/o/personal/chat",
  );
  await expect(page.getByRole("heading", { name: "Finished today" })).toBeVisible();
  await shoot(page, "now-quiet");
  await noPageScroll(page);
});

test("a pending approval shows under Needs you and is denied with the keyboard", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await staffedOrg(page, stack);
  seedApproval(stack, "ap_one", "rm -rf build", "run_x");
  await page.goto("/#/now");
  await page.reload();
  const needs = page.getByRole("region", { name: /^Needs you/ });
  await expect(needs).toBeVisible();
  const card = needs.getByRole("region", { name: "rm -rf build" });
  await expect(card.getByRole("timer")).toContainText("Expires in");
  stack.expireStepUp();
  await card.getByRole("button", { name: "Deny" }).focus();
  await page.keyboard.press("Enter");
  await usePasskey(page);
  await expect(card).toContainText("Denied rm -rf build. The command will not run.");
  await shoot(page, "now-needs");
  await noPageScroll(page);
});

test("a running run shows under Working now with a real link, and the side links work", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  const orgId = await staffedOrg(page, stack);
  seedRun(stack, "r_live01", orgId, "running", false);
  seedRun(stack, "r_done01", orgId, "failed", true);
  stack.sql(
    "INSERT INTO wakeups (id, member_id, reason, status, run_id, created_at, started_at) VALUES ('w1', 'm-bot', 'schedule', 'started', 'r_live01', ?, ?)",
    Date.now() - 600_000,
    Date.now() - 600_000,
  );
  await page.goto("/#/now");
  await page.reload();
  const working = page.getByRole("region", { name: "Working now", exact: true });
  await expect(working.getByText("@bot")).toBeVisible();
  await expect(working.getByRole("link", { name: "r_live01" })).toHaveAttribute(
    "href",
    "#/runs/r_live01",
  );
  await expect(working.getByRole("link", { name: "Follow live" })).toBeVisible();
  const finished = page.getByRole("region", { name: "Finished today", exact: true });
  await expect(finished).toContainText("The provider's rate limit or quota was reached.");
  await expect(page.getByText(/^1 running/)).toBeVisible();
  await shoot(page, "now-busy");
  await noPageScroll(page);

  const places = page.getByRole("complementary");
  for (const [name, hash] of [
    ["Runs", "#/runs"],
    ["Logs", "#/o/personal/logs"],
    ["Usage & budgets", "#/o/personal/dashboard"],
    ["Memory", "#/o/personal/memory"],
  ] as const) {
    await page.goto("/#/now");
    await page.reload();
    await places.getByRole("link", { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/#]/g, "\\$&")}$`));
  }
});

test("a person who is not an instance admin sees no Finished today", async ({ page, stack }) => {
  await signIn(page, stack, { ...ADMIN, admin: false });
  await staffedOrg(page, stack);
  await page.goto("/#/now");
  await page.reload();
  await expect(page.getByText("Nothing is running", { exact: true })).toBeVisible();
  await expect(page.getByText(/agents? working/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finished today" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
  await noPageScroll(page);
});

// A run started from the Runs page has no member, so no organisation: Now must still show it to an
// instance admin, as Runs and Approvals do.
const FAKE_AGENT = resolve(import.meta.dirname, "../../code/conformance/fake-agent.ts");
const PUSH = "git push origin harness/fix-rate-limit";
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const fakeSpec = {
  id: "fake",
  name: "Fake agent",
  lane: "acp",
  bin: bun,
  args: [
    FAKE_AGENT,
    JSON.stringify([
      { say: "reading the limiter tests" },
      { ask: { command: PUSH } },
      { hang: true },
    ]),
    "ui-e2e-now",
  ],
  versionArgs: [bun, "--version"],
  loginProbe: null,
  loginArgs: null,
  modeOption: null,
  egress: [],
  stateWrite: [],
  weakerNetworkIsolation: false,
  claudeMeta: false,
  mcp: false,
};
let repo = "";
const savedEnv = { test: process.env.HARNESS_TEST, agents: process.env.HARNESS_TEST_AGENTS };

test.beforeAll(() => {
  process.env.HARNESS_TEST = "1";
  process.env.HARNESS_TEST_AGENTS = JSON.stringify([fakeSpec]);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "harness-ui-now-")));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=ui", "-c", "user.email=ui@example.test", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  };
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
});

test.afterAll(() => {
  for (const [key, value] of [
    ["HARNESS_TEST", savedEnv.test],
    ["HARNESS_TEST_AGENTS", savedEnv.agents],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(repo, { recursive: true, force: true });
});

test("a run started from the Runs page shows under Working now and Needs you", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await staffedOrg(page, stack);
  await page.goto("/#/agents");
  await page.getByRole("switch", { name: "Use for runs" }).click();
  await usePasskey(page);
  await expect(page.getByRole("switch", { name: "Use for runs" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.goto("/#/runs");
  await page.getByRole("button", { name: "Start run" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Start a run" });
  await drawer.getByLabel("Agent", { exact: true }).selectOption("fake");
  await drawer.getByLabel("Repository path").fill(repo);
  await drawer.getByLabel("Prompt").fill("Fix the flaky rate limiter test");
  await drawer.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/#\/runs\/[0-9a-f-]+$/);
  const id = page.url().split("/runs/")[1] ?? "";
  await expect(page.getByRole("region", { name: "git push origin …" })).toBeVisible();

  await page.goto("/#/now");
  await page.reload();
  const needs = page.getByRole("region", { name: /^Needs you/ });
  await expect(needs.getByRole("region", { name: "git push origin …" })).toBeVisible();
  const working = page.getByRole("region", { name: "Working now", exact: true });
  await expect(working.getByRole("link", { name: id }).first()).toBeVisible();

  // The stub agent hangs, so the run is stopped here; a live child would still hold the server's
  // home folder when the fixture removes it.
  await page.goto(`/#/runs/${id}`);
  await page.getByRole("button", { name: "Stop run" }).click();
  await page
    .getByRole("dialog", { name: `Stop run ${id}?` })
    .getByRole("button", { name: "Stop run" })
    .click();
  await expect(page.locator(".run-head").getByText("killed", { exact: true })).toBeVisible();
});
