import { expect, test } from "bun:test";
import { getOrCreateSubscription } from "./push-subscribe";

test("reuses the browser subscription when linking another organization", async () => {
  const existing = { endpoint: "https://push.example/sub" } as PushSubscription;
  let created = false;
  const registration = {
    pushManager: {
      getSubscription: async () => existing,
      subscribe: async () => {
        created = true;
        return {} as PushSubscription;
      },
    },
  } as ServiceWorkerRegistration;

  const result = await getOrCreateSubscription(registration, new ArrayBuffer(0));

  expect(result).toEqual({ subscription: existing, created: false });
  expect(created).toBe(false);
});
