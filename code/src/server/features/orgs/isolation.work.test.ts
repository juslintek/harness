import { type Case, defineCases, type Fixture, type Ids, post } from "./isolation-kit";

// A second task in the same project, so dependency routes have a valid other end.
async function otherTask(f: Fixture): Promise<Ids> {
  const t = await post(f, `/api/projects/${f.ids.project}/tasks`, { title: "dep target" });
  return { other: t.id };
}

// Checkout and release change the task, so each run gets its own; release needs one already held.
async function freshTask(f: Fixture, held: boolean): Promise<Ids> {
  const t = await post(f, `/api/projects/${f.ids.project}/tasks`, { title: "fresh" });
  if (held) await post(f, `/api/tasks/${t.id}/checkout`, {});
  return { fresh: t.id };
}

const cases: Case[] = [
  { name: "board list tasks", method: "GET", path: (i) => `/api/projects/${i.project}/tasks` },
  { name: "board members", method: "GET", path: (i) => `/api/projects/${i.project}/members` },
  { name: "board deps", method: "GET", path: (i) => `/api/projects/${i.project}/deps` },
  {
    name: "board create task",
    method: "POST",
    path: (i) => `/api/projects/${i.project}/tasks`,
    body: () => ({ title: "x" }),
  },
  { name: "board get task", method: "GET", path: (i) => `/api/tasks/${i.task}` },
  {
    name: "board patch task",
    method: "PATCH",
    path: (i) => `/api/tasks/${i.task}`,
    body: () => ({ title: "renamed" }),
  },
  {
    name: "board comment",
    method: "POST",
    path: (i) => `/api/tasks/${i.task}/comments`,
    body: () => ({ body: "x" }),
  },
  {
    name: "board add dependency",
    method: "POST",
    path: (i) => `/api/tasks/${i.task}/deps`,
    body: (i) => ({ dependsOn: i.other }),
    fresh: otherTask,
  },
  {
    name: "board remove dependency",
    method: "DELETE",
    path: (i) => `/api/tasks/${i.task}/deps`,
    body: (i) => ({ dependsOn: i.other }),
    fresh: otherTask,
  },
  {
    name: "board move",
    method: "POST",
    path: (i) => `/api/tasks/${i.task}/move`,
    body: () => ({ to: "todo" }),
  },
  {
    name: "board checkout",
    method: "POST",
    path: (i) => `/api/tasks/${i.fresh}/checkout`,
    fresh: (f) => freshTask(f, false),
  },
  {
    name: "board release",
    method: "POST",
    path: (i) => `/api/tasks/${i.fresh}/release`,
    fresh: (f) => freshTask(f, true),
  },
  { name: "chat channels", method: "GET", path: () => "/api/orgs/alpha/channels" },
  {
    name: "chat create group",
    method: "POST",
    path: () => "/api/orgs/alpha/groups",
    body: () => ({ name: "x", memberIds: [] }),
  },
  {
    name: "chat open dm",
    method: "POST",
    path: () => "/api/orgs/alpha/dms",
    body: (i) => ({ memberId: i.peer }),
  },
  { name: "chat messages", method: "GET", path: (i) => `/api/channels/${i.channel}/messages` },
  { name: "chat group messages", method: "GET", path: (i) => `/api/channels/${i.group}/messages` },
  {
    name: "chat post",
    method: "POST",
    path: (i) => `/api/channels/${i.channel}/messages`,
    body: () => ({ body: "x" }),
  },
  { name: "chat members", method: "GET", path: (i) => `/api/channels/${i.channel}/members` },
  { name: "chat read", method: "POST", path: (i) => `/api/channels/${i.channel}/read` },
  {
    name: "chat project channel",
    method: "GET",
    path: (i) => `/api/channels/${i.projectChannel}/messages`,
  },
];

defineCases("org isolation: board and chat", cases);
