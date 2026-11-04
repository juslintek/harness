import { expect, spyOn, test } from "bun:test";
import { hiringWorld } from "../../test-support/hiring-kit";
import { wireHiring } from "./wiring";

test("a runtime probe still in flight at stop touches neither the db nor the ready set", async () => {
  const w = hiringWorld();
  let landed: (() => void) | null = null;
  const agents = (): Promise<never[]> =>
    new Promise((resolve) => {
      landed = () => resolve([]);
    });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const hiring = wireHiring(
      w.db,
      { runDeps: { home: "/unused", port: 1 }, home: "/unused" },
      { agents },
    );
    hiring.stop();
    w.db.close();
    (landed as (() => void) | null)?.();
    await Bun.sleep(20);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
  }
});
