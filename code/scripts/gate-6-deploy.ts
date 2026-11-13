// Gate 6 assertions 1 to 3: the host binary, target discovery and an approved deploy over the
// local transport (no ssh, no real host).
import { Database } from "bun:sqlite";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono as HonoApp } from "hono";
import { Hono } from "hono";
import { getSecret, setSecret } from "../src/server/features/agents/api";
import { sessionMiddleware } from "../src/server/features/auth/api";
import { deployRoutes } from "../src/server/features/deploy/api";
import { localTransport } from "../src/server/features/deploy/local-transport";
import type { Transport } from "../src/server/features/deploy/transport";
import { sessionHeaders } from "../src/server/test-support/app-kit";
import { build, hostTarget } from "./build";
import { bootInstance, enrollAdmin, type Instance, signIn, stepUp } from "./gate-5-kit";
import {
  call,
  filesContaining,
  filesUnder,
  freePort,
  type GateLog,
  sha256,
  tempDir,
} from "./gate-6-kit";

export const BUILD_VERSION = "6.0.0-gate";
const FAKE_BIN = join(import.meta.dir, "..", "src", "server", "test-support", "fake-bin-dist");

export interface Built {
  dir: string;
  name: string;
  path: string;
}

// Assertion 1.
export async function buildHost(log: GateLog): Promise<Built> {
  const dir = tempDir("dist");
  const path = await build({ target: hostTarget(), out: dir, version: BUILD_VERSION });
  const sum = sha256(path);
  log.print(`binary ${path} ${statSync(path).size} bytes sha256 ${sum}`);
  const sidecar = (await Bun.file(`${path}.sha256`).text()).split(" ")[0];
  log.report.check(1, sidecar === sum && statSync(path).size > 10_000_000, "host binary built");
  return { dir, name: path.split("/").at(-1) ?? "", path };
}

interface DeployHost {
  inst: Instance;
  targetRoot: string;
  transport: ReturnType<typeof localTransport>;
  puts: { path: string; text: string }[];
  sshConfig: string;
}

async function bootDeployHost(built: Built): Promise<DeployHost> {
  const dir = tempDir("deploy");
  const sshConfig = join(dir, "ssh-config");
  writeFileSync(sshConfig, "Host box\n  HostName 127.0.0.1\n  User deploy\n");
  const targetRoot = join(dir, "root");
  mkdirSync(targetRoot);
  const transport = localTransport(targetRoot);
  const puts: DeployHost["puts"] = [];
  const recording: Transport = {
    ...transport,
    put: (path, bytes, mode) => {
      puts.push({ path, text: new TextDecoder().decode(bytes.slice(0, 2000)) });
      return transport.put(path, bytes, mode);
    },
  };
  const wrap = (app: HonoApp, ctx: { db: Instance["db"]; origin: string }): HonoApp => {
    const outer = new Hono();
    outer.use("/api/deploy/*", sessionMiddleware(ctx.db, ctx.origin));
    outer.route(
      "/api/deploy",
      deployRoutes(ctx.db, {
        home: join(dir, "home"),
        ownUrl: ctx.origin,
        distDirs: [built.dir],
        discovery: { sshConfigPath: sshConfig, bin: FAKE_BIN },
        healthTimeoutMs: 90_000,
        transportFor: () => recording,
      }),
    );
    outer.route("/", app);
    return outer;
  };
  const inst = await bootInstance({ home: join(dir, "home"), wrap });
  return { inst, targetRoot, transport, puts, sshConfig };
}

// Assertion 2.
async function discovery(log: GateLog, host: DeployHost, cookie: string): Promise<void> {
  const { inst } = host;
  const listed = await call(inst.client, "GET", "/api/deploy/targets", cookie);
  const found = listed.list.map((t) => String(t.kind));
  log.print(`targets: ${found.join(",")}`);
  const ordinary = await sessionHeaders(inst.db, { admin: false, origin: inst.origin });
  const denied = await call(
    inst.client,
    "GET",
    "/api/deploy/targets",
    ordinary.headers.cookie ?? "",
  );
  log.report.check(
    2,
    listed.status === 200 &&
      ["ssh", "tailscale", "docker"].every((k) => found.includes(k)) &&
      denied.status === 403,
    `discovery lists ${found.join("/")}; non-admin gets ${denied.status}`,
  );
}

const instanceIdOf = (db: Database): string =>
  db.query<{ id: string }, []>("SELECT id FROM instance").get()?.id ?? "";

function peerIds(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ id: string }, []>("SELECT id FROM peers WHERE revoked_at IS NULL")
      .all()
      .map((r) => r.id);
  } finally {
    db.close();
  }
}

// Assertion 3. The cookie is a session without step-up, as after a plain sign-in.
async function deploy(log: GateLog, host: DeployHost, built: Built): Promise<void> {
  const { inst } = host;
  const secret = `gate6-secret-${crypto.randomUUID()}`;
  setSecret("gate6.test-secret", secret, inst.home);
  const cookie = await signIn(inst);
  const port = freePort();
  const made = await call(inst.client, "POST", "/api/deploy/requests", cookie, {
    targetId: "ssh:box",
    binary: built.name,
    port,
  });
  const id = String(made.json.id);
  const early = await call(inst.client, "POST", `/api/deploy/requests/${id}/run`, cookie);
  const noStepUp = await call(inst.client, "POST", `/api/deploy/requests/${id}/decide`, cookie, {
    decision: "approve",
  });
  await stepUp(inst, cookie);
  const approved = await call(inst.client, "POST", `/api/deploy/requests/${id}/decide`, cookie, {
    decision: "approve",
  });
  const started = await call(inst.client, "POST", `/api/deploy/requests/${id}/run`, cookie);
  const done = await pollDeploy(inst, cookie, id);
  log.print(`deploy ${id}: ${JSON.stringify(done)}`);
  const newHome = join(host.targetRoot, "home/deploy/.harness/home");
  const newId = String((done.result as { instanceId?: string } | null)?.instanceId ?? "");
  const mine = peerIds(join(newHome, "harness.db"));
  const ours = inst.db
    .query<{ id: string }, []>("SELECT id FROM peers")
    .all()
    .map((r) => r.id);
  const token = host.puts.find((p) => p.path.endsWith("pair-invite"))?.text ?? "";
  const unit = host.puts.find((p) => /\.(service|plist)$/.test(p.path))?.text ?? "";
  const leaks = [
    ...filesContaining(host.targetRoot, secret),
    ...filesContaining(host.targetRoot, getSecret("federation.key", inst.home) ?? "no-key"),
    ...filesContaining(host.targetRoot, token || "no-token"),
  ];
  const ownSecrets = filesUnder(host.targetRoot).filter((f) => f.endsWith("secrets.json"));
  log.print(`secrets.json on target: ${ownSecrets.length}, leaking files: ${leaks.length}`);
  log.report.check(
    3,
    early.status === 409 &&
      noStepUp.status === 403 &&
      approved.status === 200 &&
      started.status === 202 &&
      done.status === "done" &&
      newId.length > 0 &&
      mine.includes(instanceIdOf(inst.db)) &&
      ours.includes(newId) &&
      leaks.length === 0 &&
      token.length > 0 &&
      !unit.includes(token),
    `deploy refused before approval (${early.status}), no step-up ${noStepUp.status}, then done and paired both ways, no secret on target`,
  );
}

async function pollDeploy(
  inst: Instance,
  cookie: string,
  id: string,
): Promise<Record<string, unknown>> {
  const end = Date.now() + 120_000;
  for (;;) {
    const got = (await call(inst.client, "GET", `/api/deploy/requests/${id}`, cookie)).json;
    if (got.status === "done" || got.status === "failed" || Date.now() > end) return got;
    await Bun.sleep(500);
  }
}

export async function runDeployPart(log: GateLog, built: Built): Promise<void> {
  const host = await bootDeployHost(built);
  try {
    const admin = await enrollAdmin(host.inst);
    await discovery(log, host, admin.cookie);
    await deploy(log, host, built);
  } finally {
    host.transport.stop();
    await host.inst.stop();
  }
}
