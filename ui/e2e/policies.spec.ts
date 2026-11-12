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
      members: { id: string; handle: string }[];
    };
    return { orgId: detail.org.id, memberId: detail.members[0]?.id ?? "" };
  });

const row = (page: Page, key: string) => page.locator("li.policy-card", { hasText: key });

async function seedProposal(page: Page, stack: Stack, status = "open"): Promise<void> {
  const { orgId, memberId } = await orgInfo(page);
  stack.sql(
    `INSERT INTO policy_proposals (id, org_id, layer, target_id, key, value, reason, proposed_by, status, created_at)
     VALUES (?, ?, 'agent', ?, 'autonomy', '"strict"', 'Reviewer touched the release branch.', ?, ?, ?)`,
    `p-${status}`,
    orgId,
    memberId,
    memberId,
    status,
    Date.now(),
  );
}

test("a policy is edited at the org layer and cleared after confirming", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(page.getByRole("heading", { name: "Policies", level: 2 })).toBeVisible();
  await expect(row(page, "autonomy")).toContainText("from default");
  await expect(row(page, "autonomy")).toContainText("full");

  await page.getByRole("button", { name: "Edit autonomy at org layer" }).click();
  await page.getByLabel("Value for autonomy").selectOption("supervised");
  await page.getByRole("button", { name: "Save at org layer" }).click();
  await usePasskey(page);
  await expect(row(page, "autonomy")).toContainText("from org");
  await expect(row(page, "autonomy")).toContainText("supervised");
  await row(page, "autonomy").getByText("Chain (").click();
  await expect(row(page, "autonomy")).toContainText("org: supervised");

  await page.getByRole("button", { name: "Clear autonomy at org layer" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "autonomy")).toContainText("from org");
  await page.getByRole("button", { name: "Clear autonomy at org layer" }).click();
  await dialog.getByRole("button", { name: "Clear policy" }).click();
  await expect(row(page, "autonomy")).toContainText("from default");
});

test("a wrong value shows its error and keyboard Enter saves", async ({ page, stack }) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await page.getByRole("button", { name: "Edit hiring.autoMinScore at org layer" }).click();
  const input = page.getByLabel("Value for hiring.autoMinScore");
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
  await expect(row(page, "hiring.autoMinScore")).toContainText("from org");
  await expect(row(page, "hiring.autoMinScore")).toContainText("4");
});

test("a list policy accepts names and an empty box means no restriction", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(row(page, "router.allowedRuntimes")).toContainText("no restriction");
  await page.getByRole("button", { name: "Edit router.allowedRuntimes at org layer" }).click();
  await page.getByLabel(/^Value for router.allowedRuntimes/).fill("claude, codex");
  await page.getByRole("button", { name: "Save at org layer" }).click();
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
  await page.getByLabel("Scope", { exact: true }).selectOption("team");
  await expect(page.getByLabel("Team", { exact: true })).toContainText("Platform");
  await page.getByRole("button", { name: "Edit hiring.decision at team layer" }).click();
  await page.getByLabel("Value for hiring.decision").selectOption("human");
  await page.getByRole("button", { name: "Save at team layer" }).click();
  await usePasskey(page);
  await expect(row(page, "hiring.decision")).toContainText("from team");

  await page.getByLabel("Scope", { exact: true }).selectOption("org");
  await expect(row(page, "hiring.decision")).toContainText("from default");

  await page.getByLabel("Scope", { exact: true }).selectOption("task");
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
  await page.getByLabel("Scope", { exact: true }).selectOption("task");
  await page.getByLabel("Task number").fill("99");
  await expect(page.getByText("No task with that number.")).toBeVisible();
  await page.getByLabel("Task number").fill(String(made.number));
  await expect(page.getByText("Fix the login redirect")).toBeVisible();
  await page.getByRole("button", { name: "Edit autonomy at task layer" }).click();
  await page.getByLabel("Value for autonomy").selectOption("strict");
  await page.getByRole("button", { name: "Save at task layer" }).click();
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
  const item = page.locator("li.policy-card", { hasText: "Whole org" });
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

test("an open proposal is approved with a reason; a rejected one asks first", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, ADMIN);
  await page.goto("/#/o/acme/policies");
  await expect(page.getByText("No proposals.")).toBeVisible();
  await seedProposal(page, stack);
  await seedProposal(page, stack, "rejected");
  await page.reload();
  const card = page.locator("li.policy-card", { hasText: "proposes" });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("autonomy");
  await expect(card.locator(".badge")).toHaveText("open");

  await page.getByLabel("Show").selectOption("all");
  await expect(card).toHaveCount(2);
  await page.getByLabel("Show").selectOption("open");
  await expect(card).toHaveCount(1);

  await page.getByRole("button", { name: "Reject autonomy proposal" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(card.locator(".badge")).toHaveText("open");
  await page.getByLabel(/^Reason for autonomy decision/).fill("Not now");
  await page.getByRole("button", { name: "Approve autonomy proposal" }).click();
  await usePasskey(page);
  await expect(page.getByText("No proposals.")).toBeVisible();
  await page.getByLabel("Show").selectOption("all");
  await expect(page.getByText("Decision: Not now")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Policies", level: 2 })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
});
