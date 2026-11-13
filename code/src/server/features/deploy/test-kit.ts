import type { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { withActor } from "../../test-support/app-kit";
import { makeHome, tempDir } from "../../test-support/selfupdate-kit";
import type { AuthEnv, Session } from "../auth/api";
import { deployRoutes } from "./api";
import { type LocalTransport, localTransport } from "./local-transport";
import type { Transport } from "./transport";

export interface Kit {
  db: Database;
  home: string;
  dist: string;
  targetRoot: string;
  puts: { path: string; text: string }[];
  transport: LocalTransport;
  transportsMade: () => number;
  api: (session?: Partial<Session>) => Hono<AuthEnv>;
}

export const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// One target, `ssh:box` at loopback, backed by a local transport: no test reaches a real host.
export function makeKit(
  ownUrl = "http://127.0.0.1:1",
  healthTimeoutMs = 500,
  hostName = "127.0.0.1",
): Kit {
  const { db, home } = makeHome();
  const dist = join(home, "dist");
  mkdirSync(dist);
  const dir = tempDir("deploy-target");
  writeFileSync(join(dir, "config"), `Host box\n  HostName ${hostName}\n`);
  const targetRoot = join(dir, "root");
  mkdirSync(targetRoot);
  const transport = localTransport(targetRoot);
  const puts: Kit["puts"] = [];
  let made = 0;
  const recording: Transport = {
    ...transport,
    put: (path, bytes, mode) => {
      puts.push({ path, text: new TextDecoder().decode(bytes.slice(0, 400)) });
      return transport.put(path, bytes, mode);
    },
  };
  const routes = deployRoutes(db, {
    home,
    ownUrl,
    distDirs: [dist],
    discovery: { sshConfigPath: join(dir, "config"), bin: "/no/such/bin" },
    healthTimeoutMs,
    transportFor: () => {
      made += 1;
      return recording;
    },
  });
  return {
    db,
    home,
    dist,
    targetRoot,
    puts,
    transport,
    transportsMade: () => made,
    api: (session) => withActor(routes, session),
  };
}

export function addBinary(dist: string, name: string, body = "#!/bin/sh\nexit 0\n"): void {
  writeFileSync(join(dist, name), body);
  chmodSync(join(dist, name), 0o755);
}

export function linkOut(dist: string, name: string, to: string): void {
  symlinkSync(to, join(dist, name));
}
