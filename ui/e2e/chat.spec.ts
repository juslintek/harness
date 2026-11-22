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

  await expect(
    page.getByText("Enter to send · Shift+Enter for a new line · @ to ask an agent"),
  ).toBeVisible();
  // A message with no replies shows "Reply" only on hover or focus.
  await expect(list.getByRole("button", { name: "Reply" }).first()).toHaveCSS("opacity", "0");
  await list.getByRole("listitem").first().hover();
  await expect(list.getByRole("button", { name: "Reply" }).first()).toHaveCSS("opacity", "1");
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

  // Wait for scroll to settle so atBottom is definitely false before testing the same-frame race.
  await scroller.evaluate(
    (el) =>
      new Promise<void>((done) => {
        el.addEventListener("scroll", () => done(), { once: true });
        el.scrollTop = 0;
      }),
  );
  // Jump to bottom and post in the same frame before onScroll fires.
  await page.evaluate(async (channelId) => {
    const el = document.querySelector(".pane-scroll");
    if (!el) throw new Error("no pane-scroll");
    el.scrollTop = el.scrollHeight;
    const res = await fetch(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "arrived in same frame" }),
    });
    if (!res.ok) throw new Error(`POST failed: HTTP ${res.status}`);
  }, org.id);
  await expect(list).toContainText("arrived in same frame");
  await expect.poll(gap).toBeLessThan(48);

  // Scroll to top and post in the same frame before onScroll fires.
  await page.evaluate(async (channelId) => {
    const el = document.querySelector(".pane-scroll");
    if (!el) throw new Error("no pane-scroll");
    el.scrollTop = 0;
    const res = await fetch(`/api/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "arrived while reading" }),
    });
    if (!res.ok) throw new Error(`POST failed: HTTP ${res.status}`);
  }, org.id);
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

test("a started wakeup shows a strip under the header, and an agent DM says agent", async ({
  page,
  stack,
}) => {
  await signIn(page, stack, { ...who, admin: true });
  const org = (await call(page, "GET", "/api/orgs/personal")) as { org: { id: string } };
  stack.sql(
    "INSERT INTO members (id, org_id, kind, agent_id, handle, display_name, role, created_at) VALUES ('m-bot', ?, 'agent', 'bot-agent', 'bot', 'Bot', 'member', 1)",
    org.org.id,
  );
  await page.goto("/#/o/personal/chat");
  const channels = (await call(page, "GET", "/api/orgs/personal/channels")) as {
    id: string;
    kind: string;
  }[];
  const channel = channels.find((c) => c.kind === "org")?.id;
  stack.sql(
    "INSERT INTO wakeups (id, member_id, reason, channel_id, status, run_id, created_at, started_at) VALUES ('w1', 'm-bot', 'mention', ?, 'started', 'r_4f2a9c', ?, ?)",
    channel ?? "",
    Date.now() - 420_000,
    Date.now() - 420_000,
  );
  await page.goto(`/#/o/personal/chat/${channel}`);
  await page.reload();
  const strip = page.locator(".working-strip");
  await expect(strip).toContainText("bot is working");
  await expect(strip).toContainText("7 min");
  await expect(strip.getByRole("link", { name: "r_4f2a9c" })).toHaveAttribute(
    "href",
    "#/runs/r_4f2a9c",
  );
  await page.getByRole("button", { name: "New DM" }).click();
  const dialog = page.getByRole("dialog", { name: "New direct message" });
  await dialog.getByLabel(/Bot/).check();
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Channels" })
      .getByRole("list", { name: "Direct messages" }),
  ).toContainText("bot (agent)");
});
