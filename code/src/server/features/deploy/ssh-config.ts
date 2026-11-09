import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export interface SshHost {
  name: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

const MAX_BYTES = 256 * 1024;

function insideDir(dir: string, file: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try {
    const text = readFileSync(file, "utf8");
    return text.length > MAX_BYTES ? "" : text;
  } catch {
    return "";
  }
}

function includePaths(arg: string, dir: string): string[] {
  const pattern = arg.startsWith("~/") ? arg.slice(2) : arg;
  const base = isAbsolute(pattern) ? pattern : join(dir, pattern);
  const found = [...new Bun.Glob(base).scanSync({ absolute: true, onlyFiles: true })];
  return found.filter((file) => insideDir(dir, file)).sort();
}

function splitLine(line: string): [string, string] | null {
  const m = /^\s*([A-Za-z]+)\s*(?:=|\s)\s*(.*?)\s*$/.exec(line);
  const value = m?.[2]?.replace(/^"(.*)"$/, "$1");
  return m?.[1] && value ? [m[1].toLowerCase(), value] : null;
}

function hostsFor(value: string): SshHost[] {
  // A pattern or negation could match many machines; only literal names are listed.
  return value
    .split(/\s+/)
    .filter((n) => !/[*?!]/.test(n))
    .map((name) => ({ name, hostName: name }));
}

function entries(text: string): [string, string][] {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map(splitLine)
    .filter((kv): kv is [string, string] => kv !== null);
}

function parseText(text: string, dir: string, followIncludes: boolean): SshHost[] {
  const hosts: SshHost[] = [];
  let current: SshHost[] = [];
  for (const [key, value] of entries(text)) {
    if (key === "host") {
      current = hostsFor(value);
      hosts.push(...current);
    } else if (key === "match") {
      current = [];
    } else if (key === "include") {
      if (followIncludes) hosts.push(...included(value, dir));
    } else {
      for (const host of current) apply(host, key, value);
    }
  }
  return hosts;
}

function included(value: string, dir: string): SshHost[] {
  return value
    .split(/\s+/)
    .flatMap((p) => includePaths(p, dir))
    .flatMap((path) => parseText(readText(path), dir, false));
}

function apply(host: SshHost, key: string, value: string): void {
  // ssh keeps the first value it sees for each option.
  if (key === "hostname" && host.hostName === host.name) host.hostName = value;
  else if (key === "user") host.user ??= value;
  else if (key === "identityfile") host.identityFile ??= value;
  else if (key === "port") {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port < 65536) host.port ??= port;
  }
}

export function discoverSsh(configPath: string): SshHost[] {
  if (!existsSync(configPath)) return [];
  return parseText(readText(configPath), dirname(configPath), true);
}
