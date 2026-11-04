import { realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// A deny rule on a path does not cover the same file reached through a symlink, so each rule also
// gets its resolved form. A missing path resolves through its nearest existing ancestor with the
// whole missing suffix appended, because the agent could create the directories as links later.
export function withRealpaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((path) => {
        const direct = tryRealpath(path);
        if (direct) return [path, direct];
        let ancestor = dirname(path);
        while (ancestor !== dirname(ancestor) && !tryRealpath(ancestor))
          ancestor = dirname(ancestor);
        const real = tryRealpath(ancestor);
        return real ? [path, join(real, relative(ancestor, path))] : [path];
      }),
    ),
  ];
}
