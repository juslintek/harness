import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SERVER_NAME = "harness";

export class ConfigError extends Error {}

export interface StdioEntry {
  command: string;
  args: string[];
}

type Json = Record<string, unknown>;

export function desktopConfigPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.CLAUDE_DESKTOP_CONFIG) return env.CLAUDE_DESKTOP_CONFIG;
  const file = "claude_desktop_config.json";
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", file);
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", file);
  }
  return join(homedir(), ".config", "Claude", file);
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A missing file is an empty config; anything present but not a JSON object is refused, because
// writing over it would destroy the user's other servers.
function readConfig(path: string): Json {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError("the Claude Desktop config is not valid JSON; fix or remove it first");
  }
  if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) {
    throw new ConfigError("the Claude Desktop config has an unexpected shape");
  }
  return parsed;
}

function servers(config: Json): Json {
  return isObject(config.mcpServers) ? config.mcpServers : {};
}

export function isInstalled(path: string): boolean {
  return existsSync(dirname(path));
}

export function isLinked(path: string): boolean {
  try {
    return SERVER_NAME in servers(readConfig(path));
  } catch {
    return false;
  }
}

// Temp file in the same directory so the rename cannot cross a filesystem; the mode of an
// existing file is kept because the user may have tightened it.
function writeAtomic(path: string, config: Json): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

// The first backup is the user's original and stays: a second link must not replace it.
function backupOnce(path: string): void {
  if (!existsSync(path)) return;
  try {
    copyFileSync(path, `${path}.harness-backup`, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function checkConfig(path: string): void {
  readConfig(path);
}

export function linkConfig(path: string, entry: StdioEntry): void {
  const config = readConfig(path);
  backupOnce(path);
  writeAtomic(path, { ...config, mcpServers: { ...servers(config), [SERVER_NAME]: entry } });
}

export function unlinkConfig(path: string): void {
  if (!existsSync(path)) return;
  const config = readConfig(path);
  const { [SERVER_NAME]: removed, ...rest } = servers(config);
  if (removed === undefined) return;
  writeAtomic(path, { ...config, mcpServers: rest });
}
