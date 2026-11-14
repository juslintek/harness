import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const SHOTS = process.env.SHOTS_DIR;
const ACME = { name: "Acme Labs", slug: "acme" };
const ADA = { email: "ada@example.com", name: "Ada", orgs: [ACME] };

async function orgId(page: Page, slug: string): Promise<string> {
  return page.evaluate(async (s) => {
    const res = await fetch("/api/auth/me");
    const body = (await res.json()) as { orgs: { id: string; slug: string }[] };
    return body.orgs.find((o) => o.slug === s)?.id ?? "";
  }, slug);
}

// Notes have an HTTP path, so they are made the way the page makes them.
async function makeNote(page: Page, rel: string, body: string): Promise<string> {
  return page.evaluate(
    async ([r, b]) => {
      const res = await fetch("/api/orgs/acme/memory/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "org", rel: `${r}.md`, body: b }),
      });
      if (!res.ok) throw new Error(`create note: HTTP ${res.status}`);
      return ((await res.json()) as { note: { id: string } }).note.id;
    },
    [rel, body] as const,
  );
}

test.describe("memory", () => {
  test("creates a note from the form and opens it", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/#/o/acme/memory");
    await expect(page.getByText("No notes yet")).toBeVisible();
    await expect(
      page.getByText("agents can search and read with the memory tool", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Write the first note" }).click();
    await expect(page.getByLabel("Scope")).toBeFocused();
    await page.getByLabel(/^Name/).fill("how-to/deploy");
    await page.getByLabel("Note text").fill("Run the deploy script.\n\nSee [[Migrations]].");
    await page.getByRole("button", { name: "Create note" }).click();
    await expect(page).toHaveURL(/#\/o\/acme\/memory\/notes\/.+/);
    await expect(page.getByRole("heading", { name: "deploy" })).toBeVisible();
    await expect(page.getByText("Run the deploy script.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Notes" })).toContainText("how-to/deploy.md");
    await expect(page.getByText("No other note links here.")).toBeVisible();
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/memory-1440-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await page.screenshot({ path: `${SHOTS}/memory-1440-dark.png` });
    }
  });

  test("search and facets narrow the list, wiki links and backlinks navigate", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    await makeNote(page, "decisions/migrations", "Never edit an applied migration.");
    await makeNote(page, "how-to/deploy", "Run deploy. See [[migrations]] first.");
    await page.goto("/#/o/acme/memory");
    await expect(page.getByRole("status")).toHaveText("2 notes");
    await page.getByLabel("Search notes").fill("applied");
    await expect(page.getByRole("status")).toContainText("Showing 1 of 2 notes · applied");
    await page.getByLabel("Search notes").fill("");
    await expect(page.getByRole("status")).toHaveText("2 notes");
    const scope = page.getByRole("group", { name: "Applies to" });
    await scope.getByRole("button", { name: /org/ }).click();
    await expect(scope.getByRole("button", { name: /org/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(scope.getByRole("button", { name: /org/ })).toContainText("✓");
    await expect(page.getByRole("status")).toContainText("Showing 2 of 2 notes · org");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("status")).toHaveText("2 notes");
    await page.getByRole("link", { name: /deploy/ }).click();
    await page.getByRole("button", { name: "migrations" }).click();
    await expect(page.getByRole("heading", { name: "migrations" })).toBeVisible();
    await expect(page.getByRole("link", { name: "deploy", exact: true })).toBeVisible();
  });

  test("editing saves with the keyboard, and a conflict keeps the draft", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    const id = await makeNote(page, "facts/numbers", "first text");
    await page.goto(`/#/o/acme/memory/notes/${id}`);
    await page.getByRole("button", { name: "Edit" }).click();
    const text = page.getByLabel("Note text");
    await expect(text).toBeFocused();
    await text.fill("second text");
    await text.press("Tab");
    await page.getByRole("button", { name: "Save" }).press("Enter");
    await expect(page.locator(".memory-body")).toHaveText("second text");

    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Note text").fill("my draft");
    await page.evaluate(async (noteId) => {
      const cur = await (await fetch(`/api/orgs/acme/memory/notes/${noteId}`)).json();
      await fetch(`/api/orgs/acme/memory/notes/${noteId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: cur.hash, body: "someone else" }),
      });
    }, id);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert")).toContainText("Changed elsewhere");
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByRole("button", { name: "Reload" }).click();
    await expect(page.getByLabel("Note text", { exact: true })).toHaveValue(/^someone else\n?$/);
    await expect(page.getByLabel(/Your earlier draft/)).toHaveValue("my draft");
  });

  test("Escape asks before dropping an edited draft", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    const id = await makeNote(page, "facts/esc", "kept");
    await page.goto(`/#/o/acme/memory/notes/${id}`);
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Note text").fill("changed");
    const asked: string[] = [];
    page.once("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await page.getByLabel("Note text").press("Escape");
    await expect.poll(() => asked).toEqual(["Discard your unsaved changes?"]);
    await expect(page.getByLabel("Note text")).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByLabel("Note text").press("Escape");
    await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  });

  test("writes list shows a diff and Revert puts the text back", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    const id = await makeNote(page, "facts/hist", "one");
    await page.evaluate(async (noteId) => {
      const cur = await (await fetch(`/api/orgs/acme/memory/notes/${noteId}`)).json();
      await fetch(`/api/orgs/acme/memory/notes/${noteId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseHash: cur.hash, body: "two" }),
      });
    }, id);
    await page.goto("/#/o/acme/memory/writes");
    await expect(page.locator(".memory-diff")).toContainText("- one");
    await expect(page.locator(".memory-diff")).toContainText("+ two");
    await page.getByRole("button", { name: "Revert" }).first().click();
    await page.getByRole("button", { name: "Confirm revert" }).click();
    await page.goto(`/#/o/acme/memory/notes/${id}`);
    await expect(page.locator(".memory-body")).toHaveText("one");
    await page.goto("/#/o/acme/memory/writes");
    await page.getByLabel("Show only writes by agents").check();
    await expect(page.getByText("No writes yet.")).toBeVisible();
  });

  test("an admin accepts a pending lesson; a viewer only reads", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    const id = await orgId(page, "acme");
    stack.sql(
      "INSERT INTO lessons (id, task_id, org_id, author_handle, body, scope, type, confidence, status, created_at) VALUES ('l1', 'gone', ?, 'claude-main', 'Wait for the dialog before asserting.', 'org', 'lesson', 0.9, 'pending', 1700000000000)",
      id,
    );
    await page.goto("/#/o/acme/memory/review");
    await expect(page.locator(".badge", { hasText: /^waiting for you$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject lesson" })).toHaveAttribute(
      "data-tone",
      "secondary",
    );
    await expect(page.getByText("Task no longer exists")).toBeVisible();
    await page.getByLabel("Reason (optional)").fill("useful");
    await page.getByRole("button", { name: "Accept lesson" }).click();
    await expect(page.getByText("No lessons are waiting.")).toBeVisible();
    await page.goto("/#/o/acme/memory/notes");
    await expect(page.getByRole("list", { name: "Notes" })).toContainText("lessons/");

    stack.sql("UPDATE members SET role = 'viewer' WHERE org_id = ?", id);
    await page.goto("/#/o/acme/memory/review");
    await page.reload();
    await expect(page.getByRole("link", { name: "Writes" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Review" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New note" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Notes" })).toBeVisible();
  });

  test("a waiting lesson shows on Notes and as a count on the Review tab", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    const id = await orgId(page, "acme");
    stack.sql(
      "INSERT INTO lessons (id, task_id, org_id, author_handle, body, scope, type, confidence, status, created_at) VALUES ('l2', 'gone', ?, 'claude-main', 'Run the linter first.', 'org', 'lesson', 0.9, 'pending', 1700000000000)",
      id,
    );
    await page.goto("/#/o/acme/memory/notes");
    await expect(page.getByText("1 lesson from an agent is waiting for you")).toBeVisible();
    await expect(page.getByRole("link", { name: "Review 1" })).toBeVisible();
    await page.getByRole("link", { name: "Review lessons" }).click();
    await expect(page).toHaveURL(/#\/o\/acme\/memory\/review$/);
    await expect(page.getByLabel(/^Lesson text/)).toHaveValue("Run the linter first.");
    await expect(page.getByRole("button", { name: "Accept lesson" })).toHaveAttribute(
      "data-tone",
      "primary",
    );
  });

  test("a note shows its history, copies its path and is deleted after a named confirm", async ({
    page,
    stack,
  }) => {
    await signIn(page, stack, ADA);
    const id = await makeNote(page, "facts/gone-soon", "short lived");
    await page.goto(`/#/o/acme/memory/notes/${id}`);
    await expect(page.getByRole("button", { name: "Copy path" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("not from a run")).toBeVisible();
    await page.getByRole("button", { name: "Delete note" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("facts/gone-soon.md");
    await dialog.getByRole("button", { name: "Delete note" }).click();
    await expect(page).toHaveURL(/#\/o\/acme\/memory\/notes$/);
    await expect(page.getByText("No notes yet")).toBeVisible();
  });

  test("on a phone the filters sit behind a button", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await makeNote(page, "how-to/a", "x");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/#/o/acme/memory");
    await expect(page.getByLabel("Search notes")).toBeVisible();
    await expect(page.getByRole("group", { name: "Applies to" })).toBeHidden();
    await page.getByRole("button", { name: "Filters" }).click();
    await page
      .getByRole("group", { name: "Applies to" })
      .getByRole("button", { name: /org/ })
      .click();
    await expect(page.getByRole("button", { name: "Filters (1)" })).toBeVisible();
  });

  test("a failed list load shows the error and Retry loads it", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    let broken = true;
    await page.route("**/api/orgs/acme/memory/notes?*", (route) => {
      if (!broken) return route.continue();
      return route.fulfill({ status: 500, json: { error: "index is locked" } });
    });
    await page.goto("/#/o/acme/memory");
    await expect(page.getByRole("alert")).toContainText("index is locked");
    broken = false;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("No notes yet")).toBeVisible();
  });

  test("a missing note says so, and an unknown org is not found", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    await page.goto("/#/o/acme/memory/notes/nope");
    await expect(page.getByText("Note not found.")).toBeVisible();
    await page.goto("/#/o/nope/memory");
    await expect(page.getByText("Org not found")).toBeVisible();
  });

  test("fits a 375px screen", async ({ page, stack }) => {
    await signIn(page, stack, ADA);
    const id = await makeNote(page, "how-to/a-very-long-note-name-that-must-wrap", "x".repeat(300));
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/#/o/acme/memory/notes/${id}`);
    await expect(page.getByRole("heading", { name: /a-very-long/ })).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(fits).toBe(true);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/memory-375-light.png`, fullPage: true });
  });
});
