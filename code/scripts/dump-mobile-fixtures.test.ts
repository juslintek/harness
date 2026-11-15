import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_DIR, validateAndEmit } from "./dump-mobile-fixtures";

test("contract/mobile-fixtures/ is up to date and valid", async () => {
  const fixtures = await validateAndEmit();
  for (const [filename, data] of Object.entries(fixtures)) {
    const onDisk = JSON.parse(readFileSync(join(FIXTURES_DIR, filename), "utf8"));
    expect(onDisk).toEqual(data);
  }
});
