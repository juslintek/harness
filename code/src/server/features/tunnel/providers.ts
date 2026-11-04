import { join } from "node:path";
import type { Subprocess } from "bun";
import { type Provider, writeTunnelConfig } from "./config";
import { type Detected, detectProviders } from "./detect";

interface Command {
  bin: "tailscale" | "cloudflared";
  args: string[];
}

export interface TunnelDeps {
  home: string;
  port: number;
  // A directory holding the binaries; tests point it at stubs, otherwise PATH is used.
  bin?: string;
  env?: Record<string, string>;
  urlTimeoutMs?: number;
}

type StartResult =
  | { ok: true; origin: string | null }
  | { ok: false; status: 409 | 502; error: string };

export interface Tunnel {
  detect: () => Promise<Detected>;
  commands: (provider: Provider) => { start: string; stop: string | null };
  running: () => Provider | null;
  start: (provider: Provider) => Promise<StartResult>;
  // Without `fallback` only what this process started is undone; with it, a tailscale
  // serve/funnel config left by an earlier run is reset too.
  stop: (fallback?: Provider) => Promise<StartResult>;
}

const DEFAULT_URL_TIMEOUT_MS = 20000;
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export const isPublic = (provider: Provider): boolean => provider !== "tailscale-serve";

function startCommand(provider: Provider, port: number): Command {
  if (provider === "cloudflare") {
    return { bin: "cloudflared", args: ["tunnel", "--url", `http://127.0.0.1:${port}`] };
  }
  const verb = provider === "tailscale-serve" ? "serve" : "funnel";
  return { bin: "tailscale", args: [verb, "--bg", String(port)] };
}

// A quick tunnel is a child process that dies with its stop; tailscale keeps its config in the daemon.
function stopCommand(provider: Provider): Command | null {
  if (provider === "cloudflare") return null;
  return { bin: "tailscale", args: [provider === "tailscale-serve" ? "serve" : "funnel", "reset"] };
}

const render = (command: Command): string => [command.bin, ...command.args].join(" ");

type Child = Subprocess<"ignore", "pipe", "pipe">;

function spawn(deps: TunnelDeps, command: Command): Child {
  const path = deps.bin ? join(deps.bin, command.bin) : command.bin;
  return Bun.spawn([path, ...command.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...deps.env },
  });
}

async function runToEnd(deps: TunnelDeps, command: Command): Promise<StartResult> {
  try {
    const child = spawn(deps, command);
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code === 0) return { ok: true, origin: null };
    return {
      ok: false,
      status: 502,
      error: `${command.bin} exited ${code}: ${stderr.trim().slice(0, 300)}`,
    };
  } catch {
    return { ok: false, status: 502, error: `${command.bin} could not be run` };
  }
}

// Reads stderr until the URL shows up, then keeps draining so a chatty child never blocks on a full pipe.
async function quickTunnelUrl(child: Child, timeoutMs: number): Promise<string | null> {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(deadline - Date.now()).then(() => null),
    ]);
    if (!chunk || chunk.done) break;
    seen += decoder.decode(chunk.value, { stream: true });
    const url = QUICK_TUNNEL_URL.exec(seen)?.[0];
    if (url) {
      void (async () => {
        while (!(await reader.read()).done);
      })().catch(() => undefined);
      return url;
    }
  }
  return null;
}

export function createTunnel(deps: TunnelDeps): Tunnel {
  let current: { provider: Provider; child: Child | null } | null = null;

  async function startCloudflare(command: Command): Promise<StartResult> {
    let child: Child;
    try {
      child = spawn(deps, command);
    } catch {
      return { ok: false, status: 502, error: "cloudflared could not be run" };
    }
    const origin = await quickTunnelUrl(child, deps.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS);
    if (!origin) {
      child.kill();
      return { ok: false, status: 502, error: "cloudflared gave no tunnel url" };
    }
    writeTunnelConfig(deps.home, { provider: "cloudflare", origin });
    current = { provider: "cloudflare", child };
    void child.exited.then(() => {
      if (current?.child === child) current = null;
    });
    return { ok: true, origin };
  }

  return {
    detect: () => detectProviders(deps.bin, deps.env),
    commands: (provider) => {
      const stop = stopCommand(provider);
      return { start: render(startCommand(provider, deps.port)), stop: stop && render(stop) };
    },
    running: () => current?.provider ?? null,
    async start(provider) {
      if (current) return { ok: false, status: 409, error: "a tunnel is already running" };
      const command = startCommand(provider, deps.port);
      if (provider === "cloudflare") return startCloudflare(command);
      const result = await runToEnd(deps, command);
      if (result.ok) current = { provider, child: null };
      return result;
    },
    async stop(fallback) {
      const provider = current?.provider ?? fallback;
      const child = current?.child ?? null;
      if (child) {
        child.kill();
        await child.exited;
      }
      const command = provider ? stopCommand(provider) : null;
      const result = command
        ? await runToEnd(deps, command)
        : ({ ok: true, origin: null } as const);
      if (result.ok) current = null;
      return result;
    },
  };
}
