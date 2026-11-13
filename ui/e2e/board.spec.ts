import type { Locator, Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

interface Made {
  id: string;
  number: number;
}

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

async function project(page: Page): Promise<string> {
  const made = (await call(page, "POST", "/api/orgs/personal/projects", {
    key: "HRN",
    name: "Harness",
  })) as { id: string };
  return made.id;
}

const task = async (page: Page, projectId: string, body: object): Promise<Made> =>
  (await call(page, "POST", `/api/projects/${projectId}/tasks`, body)) as Made;

// Columns are named in plain words: "in progress", not "in_progress".
const column = (page: Page, status: string): Locator =>
  page.getByRole("region", { name: status.replace("_", " "), exact: true });

const panel = (page: Page): Locator => page.getByRole("complementary", { name: /^Task #/ });

async function open(page: Page, projectId: string, number?: number): Promise<void> {
  await page.goto(`/#/o/personal/board/${projectId}${number ? `/${number}` : ""}`);
}

test("an organisation without a project says so", async ({ page, stack }) => {
  await signIn(page, stack, { email: "none@example.com", name: "None" });
  await page.goto("/#/o/personal/board");
  await expect(page.getByText("No projects yet")).toBeVisible();
});

test("the board shows seven columns with counts and each card's facts", async ({ page, stack }) => {
  await signIn(page, stack, { email: "cols@example.com", name: "Cols" });
  const id = await project(page);
  const parent = await task(page, id, { title: "Parent job", status: "todo", estimateMinutes: 90 });
  await task(page, id, { title: "Child job", parentId: parent.id });
  await task(page, id, { title: "Shipped job", status: "done" });
  await open(page, id);
  for (const status of [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
  ]) {
    await expect(column(page, status)).toBeVisible();
  }
  await expect(column(page, "backlog").getByRole("heading")).toContainText("1");
  const card = column(page, "todo").getByRole("listitem");
  await expect(card).toContainText("Parent job");
  await expect(card).toContainText("1.5h");
  await expect(card).toContainText("1 subtask");
  await expect(card).toContainText("Unassigned");
  await expect(column(page, "done")).toContainText("Shipped job");
  await expect(column(page, "cancelled").getByRole("listitem")).toHaveCount(0);
});

test("a task moves by keyboard alone: open the card, change Status, see it in the new column", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "keys@example.com", name: "Keys" });
  const id = await project(page);
  await task(page, id, { title: "Keyboard job" });
  await open(page, id);
  await page.getByRole("link", { name: "Keyboard job" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeFocused();
  await page.keyboard.press("Tab"); // Close
  await page.keyboard.press("Tab"); // Title
  await page.keyboard.press("Tab"); // Status
  const status = panel(page).getByLabel("Status");
  await expect(status).toBeFocused();
  await expect(status).toHaveValue("backlog");
  await page.keyboard.press("t");
  await expect(status).toHaveValue("todo");
  await expect(column(page, "todo")).toContainText("Keyboard job");
  await expect(column(page, "backlog")).not.toContainText("Keyboard job");
  await expect(status).toBeFocused();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  // Close and come back to the card with the keyboard.
  await panel(page).getByRole("link", { name: "Close" }).focus();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Keyboard job" })).toBeFocused();
});

test("a refused move shows why, in words, and the task stays put", async ({ page, stack }) => {
  await signIn(page, stack, { email: "refuse@example.com", name: "Refuse" });
  const id = await project(page);
  const blocker = await task(page, id, { title: "Blocker job", status: "todo" });
  const waiting = await task(page, id, { title: "Waiting job", status: "todo" });
  await call(page, "POST", `/api/tasks/${waiting.id}/deps`, { dependsOn: blocker.id });
  await open(page, id, waiting.number);
  await expect(column(page, "todo").getByRole("listitem").nth(1)).toContainText(
    `Waiting on #${blocker.number}`,
  );
  const status = panel(page).getByLabel("Status");
  await status.selectOption("in_progress");
  await expect(panel(page).getByRole("alert")).toContainText(`depends on #${blocker.number}`);
  await expect(status).toHaveValue("todo");
  await expect(column(page, "in_progress").getByRole("listitem")).toHaveCount(0);
});

test("a parent cannot be done while a subtask is open, and ticking the subtask fixes it", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "subs@example.com", name: "Subs" });
  const id = await project(page);
  const parent = await task(page, id, { title: "Big job", status: "todo" });
  const child = await task(page, id, { title: "Small job", parentId: parent.id, status: "todo" });
  await open(page, id, parent.number);
  const status = panel(page).getByLabel("Status");
  await status.selectOption("done");
  await expect(panel(page).getByRole("alert")).toContainText(`#${child.number}`);
  await expect(status).toHaveValue("todo");

  const tick = panel(page).getByRole("checkbox", { name: `Mark #${child.number} done` });
  await expect(tick).not.toBeChecked();
  await expect(panel(page)).toContainText("0 of 1 done");
  await tick.check();
  await expect(tick).toBeChecked();
  await expect(panel(page)).toContainText("1 of 1 done");
  await expect(column(page, "done")).toContainText("Small job");

  await status.selectOption("done");
  await expect(column(page, "done")).toContainText("Big job");
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

test("dragging a card to another column moves it", async ({ page, stack }) => {
  await signIn(page, stack, { email: "drag@example.com", name: "Drag" });
  const id = await project(page);
  await task(page, id, { title: "Dragged job", status: "todo" });
  await open(page, id);
  await column(page, "todo").getByRole("listitem").dragTo(column(page, "in_review"));
  await expect(column(page, "in_review")).toContainText("Dragged job");
  await expect(column(page, "todo")).not.toContainText("Dragged job");
});

test("the panel edits the task, adds a comment, a dependency and a subtask, and the header adds a task", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "edit@example.com", name: "Edit" });
  const id = await project(page);
  const other = await task(page, id, { title: "Other job" });
  const main = await task(page, id, { title: "Main job" });
  await open(page, id, main.number);

  await panel(page).getByLabel("Title").fill("Main job renamed");
  await panel(page).getByLabel("Description").fill("Why this exists");
  await panel(page).getByLabel("Estimate (minutes)").fill("45");
  await panel(page).getByRole("button", { name: "Save" }).click();
  await expect(column(page, "backlog")).toContainText("Main job renamed");
  await expect(column(page, "backlog")).toContainText("45m");

  await panel(page).getByLabel("Add a comment").fill("First note");
  await panel(page).getByRole("button", { name: "Comment" }).click();
  await expect(panel(page).getByText("First note")).toBeVisible();
  await expect(panel(page).getByLabel("Add a comment")).toHaveValue("");

  await panel(page).getByLabel("Depends on (#n)").fill("999");
  await panel(page).getByRole("button", { name: "Add dependency" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("No task 999");
  await panel(page).getByLabel("Depends on (#n)").fill(`#${other.number}`);
  await panel(page).getByRole("button", { name: "Add dependency" }).click();
  await expect(panel(page).getByText("Other job")).toBeVisible();
  await panel(page)
    .getByRole("button", { name: `Remove dependency #${other.number}` })
    .click();
  await expect(panel(page).getByText("Other job")).toHaveCount(0);

  await panel(page).getByLabel("New subtask").fill("Part one");
  await panel(page).getByRole("button", { name: "Add", exact: true }).click();
  await expect(panel(page).getByText("Part one")).toBeVisible();
  await expect(panel(page)).toContainText("0 of 1 done");

  await panel(page).getByRole("button", { name: "Take task" }).click();
  await expect(panel(page)).toContainText("is working on it");
  await expect(column(page, "in_progress")).toContainText("Main job renamed");
  await panel(page).getByRole("button", { name: "Let go" }).click();
  await expect(panel(page)).not.toContainText("is working on it");

  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByRole("button", { name: "Add" })).toBeDisabled();
  await dialog.getByLabel("Title").fill("Fresh job");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  await expect(column(page, "backlog")).toContainText("Fresh job");
});

test("the project picker switches the board", async ({ page, stack }) => {
  await signIn(page, stack, { email: "pick@example.com", name: "Pick" });
  const first = await project(page);
  const second = (await call(page, "POST", "/api/orgs/personal/projects", {
    key: "TWO",
    name: "Second",
  })) as { id: string };
  await task(page, first, { title: "In the first" });
  await task(page, second.id, { title: "In the second" });
  await open(page, first);
  await expect(page.getByText("In the first")).toBeVisible();
  await page.getByLabel("Project").selectOption(second.id);
  await expect(page.getByText("In the second")).toBeVisible();
  await expect(page.getByText("In the first")).toHaveCount(0);
});

test("a change made elsewhere shows up without a reload", async ({ page, stack }) => {
  await signIn(page, stack, { email: "live@example.com", name: "Live" });
  const id = await project(page);
  await open(page, id);
  await expect(page.getByText("Arrives later")).toHaveCount(0);
  await task(page, id, { title: "Arrives later" });
  await expect(column(page, "backlog")).toContainText("Arrives later");
});

test("on a phone one column shows at a time and the task opens as a sheet", async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, stack, { email: "phone@example.com", name: "Phone" });
  const id = await project(page);
  await task(page, id, { title: "Todo job", status: "todo" });
  await task(page, id, { title: "Backlog job" });
  await open(page, id);
  // The first column with tasks is the one shown.
  await expect(page.getByText("Backlog job")).toBeVisible();
  await expect(page.getByText("Todo job")).toBeHidden();
  const shown = page.locator(".bd-status-select").getByLabel("Status");
  await shown.selectOption("todo");
  await expect(shown).toHaveValue("todo");
  await expect(page.getByText("Todo job")).toBeVisible();
  await expect(page.getByText("Backlog job")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole("link", { name: "Todo job" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByLabel("Status")).toHaveValue("todo");
  expect(
    await page.evaluate(() => document.querySelector(".bd-board-head")?.hasAttribute("inert")),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel(page).getByLabel("Status").selectOption("in_review");
  await expect(shown).toHaveValue("in_review");
  await panel(page).getByRole("link", { name: "Back" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`board/${id}$`));
  await expect(page.getByText("Todo job")).toBeVisible();
});

test("with a task open at 1440 every column stays in view and the page does not scroll sideways", async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, stack, { email: "wide@example.com", name: "Wide" });
  const id = await project(page);
  const one = await task(page, id, { title: "Wide job", status: "todo" });
  await open(page, id);
  await expect(page.getByText("Scroll sideways for the last columns.")).toBeVisible();
  await open(page, id, one.number);
  await expect(panel(page)).toBeVisible();
  await expect(page.getByText("Scroll sideways for the last columns.")).toHaveCount(0);
  for (const status of [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "cancelled",
  ]) {
    await expect(column(page, status)).toBeInViewport({ ratio: 1 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator(".bd-board")).toHaveJSProperty("scrollLeft", 0);
  expect(
    await page.evaluate(() => {
      const board = document.querySelector(".bd-board");
      return board ? board.scrollWidth <= board.clientWidth : false;
    }),
  ).toBe(true);
});

test("filters narrow the board by assignee, holder kind and text", async ({ page, stack }) => {
  await signIn(page, stack, { email: "filter@example.com", name: "Filter" });
  const id = await project(page);
  await task(page, id, { title: "Alpha job" });
  await task(page, id, { title: "Beta job" });
  await open(page, id);
  await page.getByLabel("Filter").fill("beta");
  await expect(page.getByRole("link", { name: "Beta job" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Alpha job" })).toHaveCount(0);
  await page.getByLabel("Filter").fill("#1");
  await expect(page.getByRole("link", { name: "Alpha job" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beta job" })).toHaveCount(0);
  await page.getByLabel("Filter").fill("");
  await page.getByRole("button", { name: "Held by an agent" }).click();
  await expect(page.getByRole("link", { name: "Alpha job" })).toHaveCount(0);
  await expect(page.getByLabel("Assignee")).toHaveValue("");
});

test("an agent working on a task shows on its card and in the panel, and Run now says what happens", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { email: "agent@example.com", name: "Agent", admin: true });
  const id = await project(page);
  const work = await task(page, id, { title: "Agent job", status: "in_progress" });
  const org = (await call(page, "GET", "/api/orgs/personal")) as { org: { id: string } };
  stack.sql(
    "INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m-bot', ?, 'agent', 'bot-agent', 'bot', 'Bot', 'member', 1)",
    org.org.id,
  );
  stack.sql(
    "INSERT INTO wakeups (id, member_id, reason, task_id, status, run_id, created_at, started_at) VALUES ('w1', 'm-bot', 'assignment', ?, 'started', 'r_4f2a9c', ?, ?)",
    work.id,
    Date.now() - 480_000,
    Date.now() - 480_000,
  );
  stack.sql(
    "INSERT INTO wakeups (id, member_id, reason, task_id, status, created_at) VALUES ('w2', 'm-bot', 'run_now', ?, 'pending', ?)",
    work.id,
    Date.now(),
  );
  await open(page, id);
  const card = column(page, "in_progress").getByRole("listitem");
  await expect(card).toContainText("working");
  await expect(card).toContainText("8m");
  await expect(card.getByRole("link", { name: "r_4f2a9c" })).toHaveAttribute(
    "href",
    "#/runs/r_4f2a9c",
  );
  await open(page, id, work.number);
  const runs = panel(page).getByRole("region", { name: "Runs" });
  await expect(runs).toContainText("Assigned");
  await expect(runs.getByRole("link", { name: "r_4f2a9c" })).toBeVisible();
  await expect(runs).toContainText("no run yet");
  await expect(runs).toContainText("queued");

  // Run now answers with a wakeup id only, so the notice says what happens and points to Now.
  await call(page, "PATCH", `/api/tasks/${work.id}`, { assigneeId: "m-bot" });
  stack.expireStepUp();
  await panel(page).getByRole("button", { name: "Run now" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await dialog.getByRole("button", { name: "Use passkey" }).click();
  await expect(
    panel(page).getByRole("status").filter({ hasText: "Asked @bot to run." }),
  ).toContainText("It starts as soon as a slot is free. Watch it under Now.");
  await panel(page).getByRole("button", { name: "Open Now" }).click();
  await expect(page).toHaveURL(/#\/now$/);
});

test("an empty project offers one New task button", async ({ page, stack }) => {
  await signIn(page, stack, { email: "empty@example.com", name: "Empty" });
  const id = await project(page);
  await open(page, id);
  await expect(page.getByText("No tasks yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(1);
});

test("a deep link opens New task with the title filled in, once", async ({ page, stack }) => {
  await signIn(page, stack, { email: "link@example.com", name: "Link" });
  const id = await project(page);
  await page.goto(`/#/o/personal/board/${id}?new=1&title=Write%20the%20post`);
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog.getByLabel("Title")).toHaveValue("Write the post");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`board/${id}$`));
  await page.goto(`/#/o/personal/board/${id}?new=0&title=Ignored`);
  await page.reload();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(dialog).toBeHidden();
});
