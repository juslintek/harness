import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

const who = { email: "chat@example.com", name: "Chat Person" };
const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });

// Calls the API from the signed-in page so the session cookie rides along.
async function call(page: Page, method: string, path: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
      return res.json();
    },
    { method, path, body },
  );
}

const invite = (page: Page) =>
  call(page, "POST", "/api/orgs/personal/members/humans", {
    email: "grace@example.com",
    role: "member",
    name: "Grace Hopper",
    handle: "grace",
  });

test("Enter sends, Shift+Enter keeps a newline, and a thread takes replies", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, who);
  await page.goto("/#/o/personal/chat");
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();
  await expect(page.getByText("No messages yet.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Channels" })).toBeVisible();

  await composer(page).fill("first line");
  await composer(page).press("Shift+Enter");
  await composer(page).pressSequentially("second line");
  await composer(page).press("Enter");
  const list = page.getByRole("list", { name: "Messages" });
  await expect(list).toContainText("first line");
  await expect(list).toContainText("second line");
  await expect(composer(page)).toHaveValue("");

  await list.getByRole("button", { name: "Reply" }).click();
  const thread = page.getByRole("complementary", { name: "Thread" });
  await thread.getByRole("textbox", { name: "Reply in thread" }).fill("a reply");
  await thread.getByRole("textbox", { name: "Reply in thread" }).press("Enter");
  await expect(thread).toContainText("a reply");
  await expect(list.getByRole("button", { name: "1 reply" })).toBeVisible();
  await thread.getByRole("button", { name: "Close" }).click();
  await expect(thread).toHaveCount(0);
});

test("a failed send keeps the text and shows the error", async ({ page, stack }) => {
  await signIn(page, stack, who);
  await page.goto("/#/o/personal/chat");
  await expect(composer(page)).toBeVisible();
  await page.route("**/api/channels/*/messages", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, json: { error: "chat is down" } })
      : route.continue(),
  );
  await composer(page).fill("will not post");
  await composer(page).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("chat is down");
  await expect(composer(page)).toHaveValue("will not post");
});

test("mentions suggest members by keyboard and a new DM opens its channel", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, who);
  await invite(page);
  await page.goto("/#/o/personal/chat");
  await composer(page).pressSequentially("hi @gr");
  await expect(page.getByRole("listbox", { name: "Mention suggestions" })).toContainText("@grace");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveValue("hi @grace ");
  await composer(page).press("Enter");
  await expect(page.locator(".mention")).toHaveText("@grace");

  await page.getByRole("button", { name: "New DM" }).click();
  const dialog = page.getByRole("dialog", { name: "New direct message" });
  await expect(dialog.getByRole("button", { name: "Create" })).toBeDisabled();
  await dialog.getByLabel(/Grace Hopper/).check();
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/#\/o\/personal\/chat\/.+/);
  const nav = page.getByRole("navigation", { name: "Channels" });
  await expect(nav.getByRole("list", { name: "Direct messages" })).toContainText("grace");
  await expect(nav.getByRole("link", { name: "grace" })).toHaveAttribute("aria-current", "page");
});

test("a new group needs a name and appears under Groups", async ({ page, stack }) => {
  await signIn(page, stack, who);
  await invite(page);
  await page.goto("/#/o/personal/chat");
  await page.getByRole("button", { name: "New group" }).click();
  const dialog = page.getByRole("dialog", { name: "New group" });
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog.getByLabel("Name")).toBeFocused();
  await dialog.getByLabel("Name").fill("release-room");
  await dialog.getByLabel(/Grace Hopper/).check();
  await dialog.getByRole("button", { name: "Create" }).click();
  const nav = page.getByRole("navigation", { name: "Channels" });
  await expect(nav.getByRole("list", { name: "Groups" })).toContainText("release-room");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("release-room");
});

test("older messages load on demand, and a new message leaves the reading position alone", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, who);
  await page.goto("/#/o/personal/chat");
  await expect(composer(page)).toBeVisible();
  const channels = (await call(page, "GET", "/api/orgs/personal/channels")) as {
    id: string;
    kind: string;
  }[];
  const org = channels.find((c) => c.kind === "org");
  if (!org) throw new Error("no org channel");
  const post = (body: string) => call(page, "POST", `/api/channels/${org.id}/messages`, { body });
  for (let i = 1; i <= 60; i++) await post(`seeded ${i}`);
  await page.reload();
  const list = page.getByRole("list", { name: "Messages" });
  await expect(list).toContainText("seeded 60");
  await expect(list).not.toContainText("seeded 10");
  await page.getByRole("button", { name: "Load older messages" }).click();
  await expect(list).toContainText("seeded 10");
  await expect(page.getByRole("button", { name: "Load older messages" })).toHaveCount(0);

  const scroller = page.locator(".pane-scroll");
  const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(gap).toBeLessThan(48);
  // A message arriving while the person is at the bottom keeps them at the bottom.
  await post("arrived at the bottom");
  await expect(list).toContainText("arrived at the bottom");
  await expect.poll(gap).toBeLessThan(48);

  // The pin-to-bottom scroll runs on the next frame; let it land before scrolling away.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  // Scrolled up, the same arrival must not move the view.
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  // The scroll event reaches the page before the next message does.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await post("arrived while reading");
  await expect(list).toContainText("arrived while reading");
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
});

test("on a phone the channel list and the conversation are separate views", async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page, stack, who);
  await page.goto("/#/o/personal/chat");
  const nav = page.getByRole("navigation", { name: "Channels" });
  await expect(nav).toBeVisible();
  await expect(page.getByRole("region", { name: "Conversation" })).toBeHidden();
  await nav.getByRole("link").first().click();
  await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
  await expect(nav).toBeHidden();
  await composer(page).fill("from a phone");
  await composer(page).press("Enter");
  await expect(page.getByRole("list", { name: "Messages" })).toContainText("from a phone");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole("link", { name: "Channels" }).click();
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
