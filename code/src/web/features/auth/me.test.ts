import { expect, test } from "bun:test";
import { isViewerIn, type Me } from "./me";

const user = { id: "u", email: "e", name: "n", instanceAdmin: false };
const orgs = [
  { id: "1", slug: "acme", name: "Acme", role: "viewer" },
  { id: "2", slug: "beta", name: "Beta", role: "member" },
];
const m: Me = { user, orgs };

test("only a viewer role in that org counts as a viewer", () => {
  expect(isViewerIn(m, "acme")).toBe(true);
  expect(isViewerIn(m, "beta")).toBe(false);
  expect(isViewerIn(m, "none")).toBe(false);
  expect(isViewerIn(null, "acme")).toBe(false);
});
