import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const FAKE_AGENT = resolve(import.meta.dirname, "../../code/conformance/fake-agent.ts");
const PUSH = "git push origin harness/fix-rate-limit";
const ADMIN = { email: "ada@acme.example", name: "Ada", admin: true };

// The server only takes a stub agent when it runs in test mode, so the whole spec starts its
// servers that way. The agent talks, asks to push (the guard answers "ask"), then waits to be killed.
const script = [{ say: "reading the limiter tests" }, { ask: { command: PUSH } }, { hang: true }];
const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
const spec = {
  id: "fake",
  name: "Fake agent",
  lane: "acp",
  bin: bun,
  args: [FAKE_AGENT, JSON.stringify(script), "ui-e2e-runs"],
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
const saved = { test: process.env.HARNESS_TEST, agents: process.env.HARNESS_TEST_AGENTS };

test.beforeAll(() => {
  process.env.HARNESS_TEST = "1";
  process.env.HARNESS_TEST_AGENTS = JSON.stringify([spec]);
  repo = realpathSync(mkdtempSync(join(tmpdir(), "harness-ui-runs-")));
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
    ["HARNESS_TEST", saved.test],
    ["HARNESS_TEST_AGENTS", saved.agents],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(repo, { recursive: true, force: true });
});

// The passkey sign-in does not count as a step-up, so the first dangerous action asks for one.
async function usePasskey(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(dialog).toBeHidden();
}

async function noPageScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

// Links the stub agent on the Agents page (a step-up), then starts a run from the Runs page.
async function startRun(page: Page): Promise<string> {
  await page.goto("/#/agents");
  await page.getByRole("switch", { name: "not linked" }).click();
  await usePasskey(page);
  await expect(page.getByRole("switch", { name: "linked", exact: true })).toBeVisible();
  await page.goto("/#/runs");
  await page.getByLabel("Agent", { exact: true }).selectOption("fake");
  await page.getByLabel("Repository path").fill(repo);
  await page.getByLabel("Prompt").fill("Fix the flaky rate limiter test");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/#\/runs\/[0-9a-f-]+$/);
  return page.url().split("/runs/")[1] ?? "";
}

test("the runs list starts empty, then lists a run started from the form", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/runs");
  await expect(page.getByText("No runs yet.")).toBeVisible();
  await expect(page.getByText("No agent is linked and installed.")).toBeVisible();

  const id = await startRun(page);
  await expect(page.getByRole("heading", { name: id })).toBeVisible();
  await page.getByRole("link", { name: "Back to runs" }).click();
  const row = page.getByRole("link", { name: new RegExp(`^Run ${id}`) });
  await expect(row).toBeVisible();
  await expect(page.getByRole("region", { name: "Runs" }).getByText("fake").first()).toBeVisible();
  await noPageScroll(page);
});

test("a pending approval is approved with the keyboard, then the run is killed", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("message");

  const card = page.getByRole("region", { name: "Approval needed" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(PUSH);
  await expect(card).toContainText(`fake · ${id}`);
  await expect(card.getByRole("timer")).toContainText("Expires in");
  await expect(card.getByText("pending", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("ask");

  stack.expireStepUp();
  await card.getByRole("button", { name: "Approve" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(card).toBeHidden();
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("approval");

  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Kill run" }).click();
  await expect(page.getByRole("button", { name: "Kill run" })).toBeHidden();
  await expect(page.locator(".run-head").getByText("killed", { exact: true })).toBeVisible();
});

test("a pending approval is denied with the keyboard from the approvals page", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("region", { name: "Approval needed" })).toBeVisible();

  await page.goto("/#/approvals");
  await expect(page.getByRole("status").filter({ hasText: "1 approval waiting" })).toBeVisible();
  const card = page.getByRole("region", { name: "Approval needed" });
  await expect(card).toContainText(PUSH);
  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  stack.expireStepUp();
  await card.getByRole("button", { name: "Deny" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Nothing waiting for a decision.")).toBeVisible();

  // A decided approval stays reachable by its own link and shows the outcome.
  const approvalId = await page.evaluate(async () => {
    const res = await fetch("/api/approvals?status=denied");
    return ((await res.json()) as { id: string }[])[0]?.id;
  });
  await page.goto(`/#/approvals/${approvalId}`);
  const decided = page.getByRole("region", { name: "Approval needed" });
  await expect(decided.getByText("denied", { exact: true })).toBeVisible();
  await expect(decided.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await page.goto(`/#/runs/${id}`);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("approval");
  await page.goto("/#/approvals/unknown-id");
  await expect(
    page.getByText("This approval does not exist, or you may not decide it."),
  ).toBeVisible();
});

test("search finds run events and says when nothing matches", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("message");
  await page.goto("/#/search");
  await page.getByLabel("Search all run events").fill("limiter");
  await page.keyboard.press("Enter");
  const hits = page.getByRole("list", { name: "Search results" });
  await expect(hits).toContainText("reading the limiter tests");
  await expect(hits.getByRole("link", { name: "Open run" }).first()).toHaveAttribute(
    "href",
    `#/runs/${id}`,
  );
  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("Search all run events").fill("zzzunmatched");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No matches.")).toBeVisible();
});

test("the agents page shows the agent and saves an API key", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/agents");
  const table = page.getByRole("region", { name: "Agents" });
  await expect(table.getByRole("row", { name: /Fake agent/ })).toBeVisible();
  await expect(table.getByRole("switch", { name: "not linked" })).toBeVisible();
  await expect(page.getByText("Ollaya (L2 guard)")).toBeVisible();
  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const key = page.getByLabel(/API key$/).first();
  await key.fill("sk-test-0123456789abcdefghij");
  await page.getByRole("button", { name: "Save key" }).first().click();
  await usePasskey(page);
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("a person who is not an instance admin does not get the instance pages", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "viv@acme.example", name: "Viv" });
  for (const route of ["runs", "agents", "search"]) {
    await page.goto(`/#/${route}`);
    await expect(page.getByText("Not available.")).toBeVisible();
  }
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Runs" }),
  ).toHaveCount(0);
});
