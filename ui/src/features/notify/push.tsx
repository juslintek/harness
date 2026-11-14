import { createSignal, type JSX, onMount, Show } from "solid-js";
import { api } from "../../api";
import { ErrorLine } from "../../auth/error-line";
import { createAction } from "../../ui/action";
import { Button } from "../../ui/atoms";
import { createdSchema, orgUrl, pushKeySchema, subscriptionSchema } from "./data";
import { applicationServerKey, needsHomeScreen, type PushState, pushState } from "./logic";

type View = PushState | "loading";

async function existingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function getOrCreateSubscription(
  registration: ServiceWorkerRegistration,
  key: BufferSource,
): Promise<{ subscription: PushSubscription; created: boolean }> {
  const existing = await registration.pushManager.getSubscription();
  if (existing) return { subscription: existing, created: false };
  return {
    subscription: await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }),
    created: true,
  };
}

async function readState(): Promise<PushState> {
  const supported = "serviceWorker" in navigator && "PushManager" in window;
  return pushState({
    hasServiceWorker: "serviceWorker" in navigator,
    hasPushManager: "PushManager" in window,
    hasNotification: "Notification" in window,
    permission: "Notification" in window ? Notification.permission : null,
    subscribed: supported && (await existingSubscription()) !== null,
  });
}

// Posting the same subscription again returns the stored row, which is how unsubscribe finds its id.
const saveSubscription = (sub: PushSubscription, org: string): Promise<{ id: string }> =>
  api(orgUrl("/api/notify/push/subscribe", org), createdSchema, {
    method: "POST",
    body: subscriptionSchema.parse(sub.toJSON()),
  });

async function subscribeThisDevice(org: string): Promise<PushState> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "ready";
  const { key } = await api("/api/notify/push/key", pushKeySchema);
  const { subscription: sub, created } = await getOrCreateSubscription(
    registration,
    Uint8Array.from(applicationServerKey(key)).buffer,
  );
  try {
    await saveSubscription(sub, org);
  } catch (err) {
    if (created) await sub.unsubscribe();
    throw err;
  }
  return "subscribed";
}

function Unsupported(): JSX.Element {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return (
    <p>
      {needsHomeScreen(navigator.userAgent, standalone)
        ? "On iPhone and iPad, push only works for a web app on the home screen. In Safari tap Share, then Add to Home Screen, open Harness from there and come back to this page."
        : "This browser cannot receive push. Push needs a browser with web push support and a page served over https (or localhost)."}
    </p>
  );
}

const STATUS: Record<Exclude<View, "unsupported" | "loading">, string> = {
  denied:
    "Notifications are blocked for this site. Allow them in the browser's site settings, then reload this page.",
  subscribed: "Push on this browser: on.",
  ready: "Push on this browser: off.",
};

export function PushSubscribe(props: { org: string; onChange: () => void }): JSX.Element {
  const [view, setView] = createSignal<View>("loading");
  const action = createAction();
  onMount(() => {
    readState().then(setView, () => setView("unsupported"));
  });
  const enable = (): void => {
    void action.run(async () => {
      setView(await subscribeThisDevice(props.org));
      props.onChange();
    });
  };
  const status = (): string | undefined => {
    const v = view();
    return v === "unsupported" || v === "loading" ? undefined : STATUS[v];
  };
  return (
    <div class="push-box">
      <Show when={view() === "unsupported"}>
        <Unsupported />
      </Show>
      <Show when={status()}>{(text) => <p>{text()}</p>}</Show>
      <Show when={view() === "ready" || view() === "subscribed"}>
        <Button disabled={action.busy()} onClick={enable}>
          {view() === "ready" ? "Enable push on this browser" : "Enable push for this organization"}
        </Button>
      </Show>
      <ErrorLine message={action.error()} />
    </div>
  );
}
