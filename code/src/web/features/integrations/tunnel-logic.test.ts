import { expect, test } from "bun:test";
import { canConfirmStart, isPublicProvider, startBody } from "./tunnel-logic";

test("only tailscale serve is private", () => {
  expect(isPublicProvider("tailscale-serve")).toBe(false);
  expect(isPublicProvider("tailscale-funnel")).toBe(true);
  expect(isPublicProvider("cloudflare")).toBe(true);
});

test("a public provider cannot be confirmed without the checkbox", () => {
  expect(canConfirmStart("cloudflare", false)).toBe(false);
  expect(canConfirmStart("cloudflare", true)).toBe(true);
  expect(canConfirmStart("tailscale-serve", false)).toBe(true);
});

test("confirmPublic is sent only for a public provider with the box ticked", () => {
  expect(startBody("cloudflare", true)).toEqual({ confirm: true, confirmPublic: true });
  expect(startBody("cloudflare", false)).toEqual({ confirm: true });
  expect(startBody("tailscale-serve", true)).toEqual({ confirm: true });
});
