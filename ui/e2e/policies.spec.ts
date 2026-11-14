import type { Page } from "@playwright/test";
import { enroll, expect, signIn, test } from "./fixtures";
import type { Stack } from "./stack";

const usePasskey = (page: Page) => page.getByRole("button", { name: "Use passkey" }).click();

const ADMIN = {
  email: "ada@acme.example",
  name: "Ada",
  admin: true,
  orgs: [{ name: "Acme Labs", slug: "acme" }],
};

const orgInfo = (page: Page) =>
  page.evaluate(async () => {
    const res = await fetch("/api/orgs/acme");
    const detail = (await res.json()) as {
      org: { id: string };
      members: { id: string; handle: string; userId: string | null }[];
    };
    return {
      orgId: detail.org.id,
      memberId: detail.members[0]?.id ?? "",
      handle: detail.members[0]?.handle ?? "",
      userId: detail.members[0]?.userId ?? "",
    };
  });

const row = (page: Page, key: string) =>
  page.locator("li.policy-card", { has: page.locator(".policy-key"), hasText: key });

async function seedProposal(page: Page, stack: Stack, status = "open"): Promise<string> {
  const { orgId, memberId, handle, userId } = await orgInfo(page);
  const now = Date.now();
  const columns =
    "id, org_id, layer, target_id, key, value, reason, proposed_by, status, created_at";
  const common = `'agent', ?, 'autonomy', '"strict"', 'Reviewer touched the release branch.', ?, ?`;
  if (status === "open") {
    stack.sql(
      `INSERT INTO policy_proposals (${columns}) VALUES (?, ?, ${common}, ?)`,
      `p-${status}`,
      orgId,
      memberId,
      memberId,
      status,
      now,
    );
  } else {
    stack.sql(
      `INSERT INTO policy_proposals (${columns}, decided_by, decision_reason, decided_at) VALUES (?, ?, ${common}, ?, ?, 'Too strict for now', ?)`,
      `p-${status}`,
      orgId,
      memberId,
      memberId,
      status,
      now,
      userId,
      now,
    );
  }
  return handle;
}

test("a policy is edited at the org layer and cleared after confirming", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(page.getByRole("heading", { name: "Rules", level: 2 })).toBeVisible();
  await expect(row(page, "autonomy")).toContainText("from default");
  await expect(row(page, "autonomy")).toContainText("Full");
  await expect(row(page, "autonomy")).toContainText("Layers: none set, default applies");
  await expect(row(page, "autonomy")).toContainText(
    "How much agents may do without asking a person.",
  );

  await page.getByRole("button", { name: "Edit Agent autonomy" }).click();
  await expect(
    page.getByText("Like Full, but manager agents may not approve commands."),
  ).toBeVisible();
  await page.getByLabel("Agent autonomy for the whole organisation").selectOption("supervised");
  await page.getByRole("button", { name: "Save for organisation" }).click();
  await usePasskey(page);
  await expect(row(page, "autonomy")).toContainText("from organisation");
  await expect(row(page, "autonomy")).toContainText("Supervised");
  await expect(row(page, "autonomy")).toContainText("Layers: organisation Supervised");

  // No confirm: the layer above applies again at once.
  await page.getByRole("button", { name: "Use default (Full)" }).click();
  await expect(row(page, "autonomy")).toContainText("from default");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a wrong value shows its error and keyboard Enter saves", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await page.getByRole("button", { name: "Edit Auto-hire minimum score" }).click();
  const input = page.getByLabel("Auto-hire minimum score for the whole organisation");
  await expect(input).toBeFocused();
  await input.fill("abc");
  await page.keyboard.press("Enter");
  await expect(page.locator(".field-error")).toHaveText("Enter a number.");

  await input.fill("9");
  await page.keyboard.press("Enter");
  await usePasskey(page);
  await expect(page.getByRole("alert")).toHaveText("invalid value");

  await input.fill("4");
  await page.keyboard.press("Enter");
  await expect(row(page, "hiring.autoMinScore")).toContainText("from organisation");
  await expect(row(page, "hiring.autoMinScore")).toContainText("4");
});

test("a list policy accepts names and an empty box means no restriction", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(row(page, "router.allowedRuntimes")).toContainText("No limit");
  await page.getByRole("button", { name: "Edit Allowed runtimes" }).click();
  await page.getByLabel(/^Allowed runtimes for the whole organisation/).fill("claude, codex");
  await page.getByRole("button", { name: "Save for organisation" }).click();
  await usePasskey(page);
  await expect(row(page, "router.allowedRuntimes")).toContainText("claude, codex");
});

test("the scope picker switches to a team and writes at that layer", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await page.evaluate(async () => {
    await fetch("/api/orgs/acme/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Platform" }),
    });
  });
  await page.reload();
  await page.getByLabel("Apply to", { exact: true }).selectOption("team");
  await expect(page.getByLabel("Team", { exact: true })).toContainText("Platform");
  await page.getByRole("button", { name: "Edit Who decides hires" }).click();
  await page.getByLabel("Who decides hires for this team").selectOption("human");
  await page.getByRole("button", { name: "Save for team" }).click();
  await usePasskey(page);
  await expect(row(page, "hiring.decision")).toContainText("from team");

  await page.getByLabel("Apply to", { exact: true }).selectOption("org");
  await expect(row(page, "hiring.decision")).toContainText("from default");

  await page.getByLabel("Apply to", { exact: true }).selectOption("task");
  await expect(page.getByText("This org has no projects yet.")).toBeVisible();
  const made = await page.evaluate(async () => {
    const post = async (path: string, body: unknown) =>
      (await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json())) as { id: string; number: number };
    const project = await post("/api/orgs/acme/projects", { key: "HRN", name: "Harness" });
    return post(`/api/projects/${project.id}/tasks`, { title: "Fix the login redirect" });
  });
  await page.reload();
  await page.getByLabel("Apply to", { exact: true }).selectOption("task");
  await page.getByLabel("Task number").fill("99");
  await expect(page.getByText("No task with that number.")).toBeVisible();
  await page.getByLabel("Task number").fill(String(made.number));
  await expect(page.getByText("Fix the login redirect")).toBeVisible();
  await page.getByRole("button", { name: "Edit Agent autonomy" }).click();
  await page.getByLabel("Agent autonomy for this task").selectOption("strict");
  await page.getByRole("button", { name: "Save for task" }).click();
  await expect(row(page, "autonomy")).toContainText("from task");
});

test("a budget is created, shown with its state, edited and deleted after confirming", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(page.getByText("No budgets set.")).toBeVisible();
  await page.getByLabel("Monthly limit (USD)").fill("100");
  await page.getByRole("button", { name: "Save budget" }).click();
  await usePasskey(page);
  const item = page.locator("li.policy-card", { hasText: "Whole organisation" });
  await expect(item).toContainText("$0.00 of $100.00");
  await expect(item.locator(".badge")).toHaveText("ok");

  await page.getByRole("button", { name: "Edit budget for Whole org" }).click();
  await expect(page.getByLabel("Monthly limit (USD)")).toHaveValue("100");
  await page.getByLabel("Monthly limit (USD)").fill("250");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(item).toContainText("of $250.00");

  await page.getByRole("button", { name: "Delete budget for Whole org" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(item).toBeVisible();
  await page.getByRole("button", { name: "Delete budget for Whole org" }).click();
  await dialog.getByRole("button", { name: "Delete budget" }).click();
  await expect(page.getByText("No budgets set.")).toBeVisible();
});

test("open proposals wait for a decision, past ones say who decided and when", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(page.getByText(/^No open proposals\./)).toBeVisible();
  await expect(page.getByText("No proposals have been decided yet.")).toBeVisible();
  await seedProposal(page, stack);
  const handle = await seedProposal(page, stack, "rejected");
  await page.reload();
  const open = page.getByRole("region", { name: "Open proposals" });
  const past = page.getByRole("region", { name: "Past proposals" });
  await expect(open.locator("li.policy-card")).toHaveCount(1);
  await expect(open).toContainText("Agent autonomy");
  await expect(open).toContainText("Strict");
  await expect(open.locator(".badge")).toHaveText("open");
  await expect(past.locator("li.policy-card")).toHaveCount(1);
  await expect(past.locator(".badge")).toHaveText("rejected");
  await expect(past).toContainText(`Decided by @${handle}: Too strict for now`);
  await expect(
    page.locator(".notice-title", { hasText: "1 policy change waits for you" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review proposal" }).click();
  await expect(open).toBeInViewport();

  await page.getByRole("button", { name: "Reject proposal for Agent autonomy" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(open.locator("li.policy-card")).toHaveCount(1);
  await page.getByLabel(/^Reason for the Agent autonomy decision/).fill("Not now");
  await page.getByRole("button", { name: "Approve proposal for Agent autonomy" }).click();
  await usePasskey(page);
  await expect(page.getByText(/^No open proposals\./)).toBeVisible();
  await expect(past.locator("li.policy-card")).toHaveCount(2);
  await expect(past).toContainText(`Decided by @${handle}: Not now`);
});

test("a paused budget shows a notice and Raise limit fills the form", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  const { orgId, memberId } = await orgInfo(page);
  stack.sql(
    "INSERT INTO runs (id, agent_id, repo, prompt, state, created_at, org_id, member_id) VALUES ('run-spend', 'a', 'r', 'p', 'done', 1, ?, ?)",
    orgId,
    memberId,
  );
  stack.sql(
    "INSERT INTO events (id, ts, run_id, kind, reported_cost_usd) VALUES ('ev-spend', ?, 'run-spend', 'usage', 12)",
    Date.now(),
  );
  stack.sql(
    "INSERT INTO budgets (id, org_id, scope_kind, scope_id, monthly_usd, created_by, updated_at) VALUES ('b-org', ?, 'org', ?, 10, 'test', 1)",
    orgId,
    orgId,
  );
  await page.reload();
  await expect(page.locator(".notice-title", { hasText: "1 budget is paused" })).toBeVisible();
  await expect(page.locator("li.policy-card .badge", { hasText: "paused" })).toBeVisible();
  await page.getByRole("button", { name: "Raise limit for Whole organisation" }).click();
  await expect(page.getByLabel("Monthly limit (USD)")).toHaveValue("10");
  await expect(page.getByLabel("Monthly limit (USD)")).toBeFocused();
});

test("a member below admin sees only a notice", async ({ page, stack, browser }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/settings");
  await page.getByLabel("Invite by email").fill("view@acme.example");
  await page.getByLabel("Role", { exact: true }).selectOption("member");
  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.locator(".notice code").textContent();
  const code = (link ?? "").split("/#/enroll/")[1] as string;

  const context = await browser.newContext({ baseURL: stack.url });
  const other = await context.newPage();
  const cdp = await context.newCDPSession(other);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await enroll(other, code, "view@acme.example", "Vera");
  await other.goto("/#/login");
  await other.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(other).toHaveURL(/#\/$/);
  await other.goto("/#/o/acme/policies");
  await expect(other.getByText("Policies are visible to org admins.")).toBeVisible();
  await expect(other.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await context.close();
});

test("an unknown org says so", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/nope/policies");
  await expect(page.getByText("Org not found")).toBeVisible();
});

test("no horizontal page scroll at phone width", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#/o/acme/policies");
  await expect(page.getByRole("heading", { name: "Rules", level: 2 })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const small = await page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>(".policies .btn")].filter(
        (b) => b.offsetParent !== null && b.getBoundingClientRect().height < 32,
      ).length,
  );
  expect(small).toBe(0);
});
