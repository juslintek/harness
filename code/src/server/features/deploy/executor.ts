import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { TargetView } from "../../../shared/distribution";
import { pairWith } from "../federation/api";
import { type DeployRequest, finish } from "./requests";
import type { RunResult, Transport } from "./transport";
import { launchdPlist, systemdUnit } from "./units";

type Os = "linux" | "darwin";

interface Layout {
  binary: string;
  home: string;
  invite: string;
  logDir: string;
  unit: string;
}

const LABEL = "dev.harness.instance";
const HEALTH_POLL_MS = 250;
const SAFE_HOME = /^\/[A-Za-z0-9_@+=:,./-]*$/;
const health = z.object({ ok: z.literal(true), instanceId: z.string().min(1) });

function layoutFor(login: string, os: Os): Layout {
  const root = `${login}/.harness`;
  return {
    binary: `${root}/bin/harness`,
    home: `${root}/home`,
    invite: `${root}/home/pair-invite`,
    logDir: `${root}/logs`,
    unit:
      os === "linux"
        ? `${login}/.config/systemd/user/harness.service`
        : `${login}/Library/LaunchAgents/${LABEL}.plist`,
  };
}

const isLoopback = (address: string): boolean =>
  ["localhost", "127.0.0.1", "::1"].includes(address);

// The instance always binds loopback: plain http must never be exposed on a network. Its host
// guard only accepts its own origin, which is http://localhost:<port> unless a tunnel is set up.
function unitText(os: Os, layout: Layout, port: number): string {
  const input = { binary: layout.binary, home: layout.home, port };
  return os === "linux"
    ? systemdUnit(input)
    : launchdPlist({ ...input, label: LABEL, logDir: layout.logDir });
}

function startCommands(os: Os, layout: Layout): string[][] {
  return os === "linux"
    ? [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "harness.service"],
      ]
    : [["launchctl", "load", "-w", layout.unit]];
}

const localUrl = (port: number): string => `http://localhost:${port}`;

export interface PlanView {
  copy: { from: string; to: string; mode: string };
  unit: Record<Os, { path: string; text: string }>;
  invite: { path: string; mode: string; note: string };
  commands: Record<Os, string[][]>;
  health: string;
  pairing: string;
}

// What the human is shown before approving. It is built by the same functions the executor runs,
// with a sample login directory because the real one is only known once connected.
export function planView(req: Pick<DeployRequest, "target" | "binaryPath" | "port">): PlanView {
  const samples: Record<Os, string> = { linux: "/home/USER", darwin: "/Users/USER" };
  const layouts = {
    linux: layoutFor(samples.linux, "linux"),
    darwin: layoutFor(samples.darwin, "darwin"),
  };
  const { address } = req.target;
  const unit = (os: Os): { path: string; text: string } => ({
    path: layouts[os].unit,
    text: unitText(os, layouts[os], req.port),
  });
  return {
    copy: { from: req.binaryPath, to: layouts.linux.binary, mode: "0755" },
    unit: { linux: unit("linux"), darwin: unit("darwin") },
    invite: {
      path: layouts.linux.invite,
      mode: "0600",
      note: "random one-time pairing code; the new instance reads it at boot and deletes the file",
    },
    commands: {
      linux: startCommands("linux", layouts.linux),
      darwin: startCommands("darwin", layouts.darwin),
    },
    health: isLoopback(address)
      ? `${localUrl(req.port)}/api/health`
      : `curl http://localhost:${req.port}/api/health, run on the target over the same connection`,
    pairing: isLoopback(address)
      ? "this instance pairs with the new one using that code; no key, login or database is copied"
      : "not done for a remote target (no code is written): pairing needs https, so give the new instance a tunnel and pair from Federation; no key, login or database is copied",
  };
}

export interface ExecutorDeps {
  home: string;
  ownUrl: string;
  transportFor: (target: TargetView) => Transport;
  healthTimeoutMs: number;
}

class StepError extends Error {}

async function ok(transport: Transport, argv: string[]): Promise<RunResult> {
  const res = await transport.run(argv);
  if (res.code !== 0) throw new StepError(`${argv[0]} failed (${res.code})`);
  return res;
}

async function detect(transport: Transport): Promise<{ os: Os; login: string }> {
  const name = (await ok(transport, ["uname", "-s"])).stdout.trim();
  const os = name === "Linux" ? "linux" : name === "Darwin" ? "darwin" : null;
  if (!os) throw new StepError(`unsupported target os: ${name.slice(0, 40)}`);
  const login = (await ok(transport, ["printenv", "HOME"])).stdout.trim();
  if (!SAFE_HOME.test(login) || login === "/") throw new StepError("unusable login directory");
  return { os, login };
}

// A loopback target is probed directly. A remote one is probed from the target itself: its
// instance only listens on loopback there, and its host guard would refuse any other Host.
async function probeHealth(transport: Transport, req: DeployRequest): Promise<string | null> {
  const url = `http://localhost:${req.port}/api/health`;
  let body: unknown = null;
  if (isLoopback(req.target.address)) {
    body = await fetch(url, { signal: AbortSignal.timeout(2000) })
      .then((res) => res.json())
      .catch(() => null);
  } else {
    const res = await transport.run(["curl", "-fsS", "--max-time", "2", url]);
    body = res.code === 0 ? (JSON.parse(res.stdout || "null") as unknown) : null;
  }
  const parsed = health.safeParse(body);
  return parsed.success ? parsed.data.instanceId : null;
}

async function waitHealthy(
  transport: Transport,
  req: DeployRequest,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instanceId = await probeHealth(transport, req).catch(() => null);
    if (instanceId) return instanceId;
    await Bun.sleep(HEALTH_POLL_MS);
  }
  throw new StepError("the new instance did not answer /api/health in time");
}

async function install(
  req: DeployRequest,
  transport: Transport,
  token: string | null,
): Promise<void> {
  const { os, login } = await detect(transport);
  const layout = layoutFor(login, os);
  const bytes = await Bun.file(req.binaryPath).bytes();
  const sum = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // The file may have changed since a human approved its hash.
  if (sum !== req.binarySha256) throw new StepError("the binary changed after it was approved");
  await transport.put(layout.binary, bytes, 0o755);
  if (os === "darwin") await transport.put(`${layout.logDir}/.keep`, new Uint8Array(), 0o644);
  const text = unitText(os, layout, req.port);
  await transport.put(layout.unit, new TextEncoder().encode(text), 0o644);
  if (token) await transport.put(layout.invite, new TextEncoder().encode(token), 0o600);
  for (const argv of startCommands(os, layout)) await ok(transport, argv);
}

const NEXT = "log in to the agents (claude, codex) on the new instance; no login was copied";

async function deploy(db: Database, req: DeployRequest, deps: ExecutorDeps, token: string) {
  const transport = deps.transportFor(req.target);
  const pairable = isLoopback(req.target.address);
  await install(req, transport, pairable ? token : null);
  const instanceId = await waitHealthy(transport, req, deps.healthTimeoutMs);
  if (!pairable)
    return {
      instanceId,
      paired: false,
      next: `${NEXT}; pair it from Federation once it has an https origin`,
    };
  const url = localUrl(req.port);
  const peer = await pairWith(db, deps.home, { url, token }, { ownUrl: deps.ownUrl });
  return { url, instanceId: peer.instanceId, paired: true, next: NEXT };
}

// Only called after claimRun moved the row approved -> running. A failure message never carries
// the pairing code, even if a lower layer put it in an error.
export async function runDeploy(
  db: Database,
  req: DeployRequest,
  deps: ExecutorDeps,
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  try {
    finish(db, req.id, "done", await deploy(db, req, deps, token));
  } catch (err) {
    const message = err instanceof Error ? err.message : "deploy failed";
    finish(db, req.id, "failed", { error: message.replaceAll(token, "[redacted]").slice(0, 300) });
  }
}
