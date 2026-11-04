// Differential mode compares two servers that necessarily mint different ids, times and tokens.
// The normalizer rewrites those so that only real behaviour differences survive the diff.
const UUID_V7 = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
// Session and run tokens are 32 random bytes in base64url without padding, so exactly 43 characters.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isEpochMs = (value: number): boolean =>
  Number.isInteger(value) && value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX;

// One normalizer per run: ids are numbered by first appearance across everything it has seen, in
// sorted key order so that two servers writing the same object in different key orders agree.
export function normalizer(): (value: Json) => Json {
  const ids = new Map<string, string>();
  const text = (value: string): string => {
    if (TOKEN.test(value)) return "<secret>";
    return value.replace(UUID_V7, (id) => {
      if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
      return ids.get(id) ?? id;
    });
  };
  const walk = (value: Json): Json => {
    if (typeof value === "string") return text(value);
    if (typeof value === "number") return isEpochMs(value) ? "<ts>" : value;
    if (Array.isArray(value)) return value.map(walk);
    if (!isObject(value)) return value;
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, walk(item)]));
  };
  return walk;
}

function diffArrays(a: Json[], b: Json[], path: string): string[] {
  const out = a.length === b.length ? [] : [`${path}: length ${a.length} vs ${b.length}`];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    out.push(...diff(a[i] ?? null, b[i] ?? null, `${path}[${i}]`));
  }
  return out;
}

function diffObjects(a: JsonObject, b: JsonObject, path: string): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const here = `${path}.${key}`;
    if (!Object.hasOwn(b, key)) out.push(`${here}: only in first`);
    else if (!Object.hasOwn(a, key)) out.push(`${here}: only in second`);
    else out.push(...diff(a[key] ?? null, b[key] ?? null, here));
  }
  return out;
}

// Compares parsed values, so key order and whitespace never count, while a key present on one
// side only does. Returns one line per difference, each with the path it was found at.
export function diff(a: Json, b: Json, path = "$"): string[] {
  if (Array.isArray(a) && Array.isArray(b)) return diffArrays(a, b, path);
  if (isObject(a) && isObject(b)) return diffObjects(a, b, path);
  return JSON.stringify(a) === JSON.stringify(b)
    ? []
    : [`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`];
}
