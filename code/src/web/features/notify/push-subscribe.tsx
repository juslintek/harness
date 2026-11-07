import { useEffect, useState } from "preact/hooks";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { useAction } from "../auth/use-action";
import { createdSchema, orgUrl, pushKeySchema, subscriptionSchema } from "./notify-data";
import { applicationServerKey, needsHomeScreen, type PushState, pushState } from "./notify-logic";

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

function Unsupported(): preact.JSX.Element {
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return needsHomeScreen(navigator.userAgent, standalone) ? (
    <p>
      On iPhone and iPad, push only works for a web app on the home screen. In Safari tap Share,
      then Add to Home Screen, open Harness from there and come back to this page.
    </p>
  ) : (
    <p>
      This browser cannot receive push. Push needs a browser with web push support and a page served
      over https (or localhost).
    </p>
  );
}

const STATUS: Record<Exclude<View, "unsupported" | "loading">, string> = {
  denied:
    "Notifications are blocked for this site. Allow them in the browser's site settings, then reload this page.",
  subscribed: "Push is active in this browser.",
  ready: "Push is off for this device.",
};

export function PushSubscribe({
  org,
  onChange,
}: {
  org: string;
  onChange: () => void;
}): preact.JSX.Element {
  const [view, setView] = useState<View>("loading");
  const action = useAction();
  useEffect(() => {
    readState().then(setView, () => setView("unsupported"));
  }, []);
  const change = (step: () => Promise<PushState>): void => {
    action
      .run(async () => {
        setView(await step());
        onChange();
      })
      .catch((err: unknown) => console.error(err));
  };
  return (
    <div class="push-box">
      {view === "unsupported" && <Unsupported />}
      {view !== "unsupported" && view !== "loading" && <p>{STATUS[view]}</p>}
      {view === "ready" && (
        <button
          type="button"
          disabled={action.busy}
          onClick={() => change(() => subscribeThisDevice(org))}
        >
          Enable push on this device
        </button>
      )}
      {view === "subscribed" && (
        <button
          type="button"
          disabled={action.busy}
          onClick={() => change(() => subscribeThisDevice(org))}
        >
          Enable push for this organization
        </button>
      )}
      <ErrorLine message={action.error} />
    </div>
  );
}
