type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => byText(a, b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value as Json;
}

// Sorted keys and a trailing newline, so two runs of the dump are byte-identical.
export const pretty = (value: unknown): string => `${JSON.stringify(sortKeys(value), null, 2)}\n`;
