import { expect, test } from "bun:test";
import { pinnedLookup, safeEndpoint } from "./api";

test("pinned DNS lookup returns the validated address without resolving the hostname again", async () => {
  const lookup = pinnedLookup("93.184.216.34");
  const actual = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("public.example.test", { family: 4, all: false }, (error, address, family) => {
      if (error) reject(error);
      else if (typeof address === "string" && family !== undefined) resolve({ address, family });
      else reject(new Error("lookup returned an address list"));
    });
  });
  expect(actual).toEqual({ address: "93.184.216.34", family: 4 });
});

test("temporary DNS lookup failures are retryable endpoint results", async () => {
  const resolve = (() =>
    Promise.reject(new Error("EAI_AGAIN"))) as typeof import("node:dns/promises").lookup;
  expect(await safeEndpoint("https://push.example.test", resolve)).toEqual({
    ok: false,
    retry: true,
  });
});
