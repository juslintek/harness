import { Glob } from "bun";

const MAX_LINES = 300;
const offenders: string[] = [];

for (const dir of ["src", "scripts"]) {
  for await (const path of new Glob(`${dir}/**/*.{ts,tsx,css,html,sql}`).scan(".")) {
    const lines = (await Bun.file(path).text()).split("\n").length;
    if (lines > MAX_LINES) offenders.push(`${path}: ${lines} lines`);
  }
}

if (offenders.length > 0) {
  console.error(`Files over ${MAX_LINES} lines:\n${offenders.join("\n")}`);
  process.exit(1);
}
