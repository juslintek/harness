import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const FAKE_AGENT = resolve(import.meta.dirname, "../../code/conformance/fake-agent.ts");
const PUSH = "git push origin harness/fix-rate-limit";
const PROMPT = "Fix the flaky rate limiter test";
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

const SHOTS = process.env.SHOTS_DIR;

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  for (const [w, h] of [
    [1440, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.screenshot({ path: `${SHOTS}/${name}-${w}-light.png`, fullPage: w === 375 });
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${SHOTS}/${name}-1440-dark.png` });
  await page.emulateMedia({ colorScheme: "light" });
}

async function noPageScroll(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

// Links the stub agent on the Agents page (a step-up), then starts a run from the Runs page.
async function startRun(page: Page): Promise<string> {
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
  await drawer.getByLabel("Prompt").fill(PROMPT);
  await drawer.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/#\/runs\/[0-9a-f-]+$/);
  return page.url().split("/runs/")[1] ?? "";
}

test("the runs list starts empty, then lists a run in its group with real links", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/runs");
  await expect(page.getByText("No runs yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start run" }).first().click();
  const drawer = page.getByRole("dialog", { name: "Start a run" });
  await expect(drawer.getByText("No agent is linked and installed.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  const id = await startRun(page);
  await expect(page.getByRole("heading", { name: id, exact: true })).toBeVisible();
  await page.getByRole("heading", { level: 1 }).getByRole("link", { name: "Runs" }).click();
  const list = page.getByRole("region", { name: "Runs" });
  await expect(list.getByRole("heading", { name: /^Waiting for you/ })).toBeVisible();
  await expect(list.getByText("waiting for you", { exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: id })).toHaveAttribute("href", `#/runs/${id}`);
  await expect(list.getByRole("link", { name: PROMPT })).toHaveAttribute("href", `#/runs/${id}`);
  await expect(list.getByRole("link", { name: "Review command" })).toHaveAttribute(
    "href",
    `#/runs/${id}`,
  );
  await expect(list.getByText("fake").first()).toBeVisible();
  await list.getByRole("link", { name: PROMPT }).click();
  await expect(page).toHaveURL(new RegExp(`#/runs/${id}$`));
  await page.goto("/#/runs");
  await expect(list.getByRole("link", { name: id })).toBeVisible();
  await shoot(page, "runs");
  await noPageScroll(page);
});

test("the run page shows the run header facts and side panels", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  const head = page.locator(".run-header");
  await expect(head.getByRole("heading", { name: id })).toBeVisible();
  await expect(head.getByText("waiting for you", { exact: true })).toBeVisible();
  await expect(head).toContainText("Paused since");
  await expect(head).toContainText("running for");
  const details = page.getByRole("region", { name: "Details" });
  await expect(details).toContainText(PROMPT);
  await expect(details).toContainText(repo);
  await expect(page.getByRole("region", { name: "Cost and usage" })).toContainText("not known");
  await expect(page.getByRole("region", { name: "Cost and usage" })).toContainText("Tokens in");
  await shoot(page, "run");
});

test("follow turns off, new events count, and jump to latest turns it back on", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await startRun(page);
  const events = page.getByRole("list", { name: "Run events" });
  await expect(events).toContainText("reading the limiter tests");
  await expect(page.getByRole("region", { name: "git push origin …" })).toBeVisible();
  const follow = page.getByRole("switch", { name: "Follow" });
  await expect(follow).toHaveAttribute("aria-checked", "true");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-checked", "false");

  stack.expireStepUp();
  await page.getByRole("button", { name: "Deny" }).click();
  await usePasskey(page);
  const jump = page.getByRole("button", { name: /^Jump to latest \(\d+ new\)$/ });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(follow).toHaveAttribute("aria-checked", "true");
  await expect(jump).toBeHidden();

  await page.getByRole("button", { name: /^Messages/ }).click();
  await expect(events).toContainText("reading the limiter tests");
  await expect(events).not.toContainText("Approval");
  await page.getByRole("button", { name: /^All/ }).click();
  await expect(events).toContainText("Approval");
});

test("a pending approval is approved with the keyboard, then the run is killed", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText(
    "reading the limiter tests",
  );

  const card = page.getByRole("region", { name: "git push origin …" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(PUSH);
  await expect(card).toContainText("@fake");
  await expect(card.getByRole("link", { name: id })).toBeVisible();
  await expect(card.getByRole("timer")).toContainText("Expires in");
  await expect(card.getByText("waiting for you", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("guard asked");

  stack.expireStepUp();
  await card.getByRole("button", { name: "Approve command" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(card).toBeHidden();
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("Approval");

  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const stop = page.getByRole("button", { name: "Stop run" });
  await stop.click();
  const confirm = page.getByRole("dialog", { name: `Stop run ${id}?` });
  await expect(confirm).toContainText("You cannot resume it");
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(stop).toBeVisible();

  await stop.focus();
  await page.keyboard.press("Enter");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(confirm.getByRole("button", { name: "Stop run" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(stop).toBeHidden();
  await expect(page.locator(".run-head").getByText("killed", { exact: true })).toBeVisible();
  await expect(page.getByText("A person stopped this run.")).toBeVisible();
  await shoot(page, "run-killed");
});

test("a pending approval is denied with the keyboard from the approvals page", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("region", { name: "git push origin …" })).toBeVisible();

  await page.goto("/#/approvals");
  await expect(page.getByRole("link", { name: "Waiting 1" })).toBeVisible();
  const card = page.getByRole("region", { name: "git push origin …" });
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
  await expect(card).toContainText("Denied git push origin …. The command will not run.");

  // A decided approval stays reachable by its own link and shows the outcome.
  const approvalId = await page.evaluate(async () => {
    const res = await fetch("/api/approvals?status=denied");
    return ((await res.json()) as { id: string }[])[0]?.id;
  });
  await page.goto(`/#/approvals/${approvalId}`);
  const decided = page.getByRole("region", { name: "git push origin …" });
  await expect(decided.getByText("denied", { exact: true })).toBeVisible();
  await expect(decided.getByRole("button", { name: "Approve command" })).toHaveCount(0);
  await page.goto(`/#/runs/${id}`);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText("Approval");
  await page.goto("/#/approvals/unknown-id");
  await expect(
    page.getByText("This approval does not exist, or you may not decide it."),
  ).toBeVisible();
});

test("search finds run events and says when nothing matches", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  const id = await startRun(page);
  await expect(page.getByRole("list", { name: "Run events" })).toContainText(
    "reading the limiter tests",
  );
  await page.goto("/#/search");
  await page.getByLabel("Search run events").fill("limiter");
  await page.keyboard.press("Enter");
  const hits = page.getByRole("list", { name: "Search results" });
  await expect(hits).toContainText("reading the limiter tests");
  await expect(hits.locator("mark").first()).toHaveText(/limiter/i);
  await expect(page.getByText(/results? for "limiter"/)).toBeVisible();
  await expect(hits.getByRole("link", { name: "Open run" }).first()).toHaveAttribute(
    "href",
    `#/runs/${id}`,
  );
  await shoot(page, "search");
  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("Search run events").fill("zzzunmatched");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No matches.")).toBeVisible();
});

test("the agents page shows the agent and saves an API key", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/agents");
  const cards = page.getByRole("region", { name: "Agent CLIs" });
  await expect(cards.getByRole("row").filter({ hasText: "Fake agent" })).toBeVisible();
  await expect(cards.getByRole("switch", { name: "Use for runs" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.getByText("Guard model (layer 2):")).toBeVisible();
  await shoot(page, "agents");
  await noPageScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const key = page.getByLabel(/API key$/).first();
  await key.fill("sk-test-0123456789abcdefghij");
  await page.getByRole("button", { name: "Save key" }).first().click();
  await usePasskey(page);
  await expect(page.getByText("Saved.")).toBeVisible();
  // A stored key is never shown back: only "Key set" and a way to replace it.
  await expect(page.getByText("Key set").first()).toBeVisible();
  await expect(page.getByText("sk-test-0123456789abcdefghij")).toHaveCount(0);
  await page.getByRole("button", { name: "Replace key" }).first().click();
  await expect(page.getByLabel(/API key$/).first()).toHaveValue("");
});

test("a person who is not an instance admin does not get the instance pages", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "viv@acme.example", name: "Viv" });
  for (const route of ["runs", "runs/some-run", "agents", "search"]) {
    await page.goto(`/#/${route}`);
    await expect(page.getByText("Not available.")).toBeVisible();
  }
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Runs" }),
  ).toHaveCount(0);
});
