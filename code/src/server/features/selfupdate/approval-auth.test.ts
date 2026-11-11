import { expect, test } from "bun:test";
import { bootApi } from "../../test-support/api-kit";
import { mintRunToken } from "../mcp/api";

const PATHS = ["/api/selfupdate/requests/x/approve", "/api/selfupdate/requests/x/deny"];

test("a run bearer token never reaches the decision routes", async () => {
  const kit = bootApi();
  const token = mintRunToken(kit.db, "r1", ["report", "guard_hook"]);
  for (const path of PATHS) {
    const res = await kit.app.request(path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: "localhost:4100",
        origin: "http://localhost:4100",
      },
    });
    expect(res.status).toBe(401);
  }
});

test("through the real session middleware: non-admin 403, admin without step-up 403", async () => {
  const kit = bootApi();
  const member = await kit.user({ admin: false, stepUp: true });
  const admin = await kit.user({ admin: true });
  for (const path of PATHS) {
    expect((await kit.call(member, "POST", path)).status).toBe(403);
    expect((await kit.call(admin, "POST", path)).status).toBe(403);
  }
  const fresh = await kit.user({ admin: true, stepUp: true });
  expect((await kit.call(fresh, "POST", PATHS[0] as string)).status).toBe(404);
});
