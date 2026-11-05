import { useEffect, useState } from "preact/hooks";
import { api } from "../../api";
import { ErrorLine } from "../auth/error-line";
import { ignored } from "../auth/me";
import { useAction } from "../auth/use-action";
import { createdSchema, pushKeySchema, subscriptionSchema } from "./notify-data";
import { applicationServerKey, needsHomeScreen, type PushState, pushState } from "./notify-logic";

type View = PushState | "loading";

async function existingSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
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
const saveSubscription = (sub: PushSubscription): Promise<{ id: string }> =>
  api("/api/notify/push/subscribe", createdSchema, {
    method: "POST",
    body: subscriptionSchema.parse(sub.toJSON()),
  });

async function subscribeThisDevice(): Promise<PushState> {
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "ready";
  const { key } = await api("/api/notify/push/key", pushKeySchema);
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(key),
  });
  try {
    await saveSubscription(sub);
  } catch (err) {
    // A browser subscription the server does not know would read as "on" while nothing arrives.
    await sub.unsubscribe();
    throw err;
  }
  return "subscribed";
}

async function unsubscribeThisDevice(): Promise<PushState> {
  const sub = await existingSubscription();
  if (!sub) return "ready";
  const { id } = await saveSubscription(sub);
  await api(`/api/notify/targets/${encodeURIComponent(id)}`, ignored, { method: "DELETE" });
  await sub.unsubscribe();
  return "ready";
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
  subscribed: "Push is on for this device.",
  ready: "Push is off for this device.",
};

export function PushSubscribe({ onChange }: { onChange: () => void }): preact.JSX.Element {
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
        <button type="button" disabled={action.busy} onClick={() => change(subscribeThisDevice)}>
          Enable push on this device
        </button>
      )}
      {view === "subscribed" && (
        <button type="button" disabled={action.busy} onClick={() => change(unsubscribeThisDevice)}>
          Turn push off for this device
        </button>
      )}
      <ErrorLine message={action.error} />
    </div>
  );
}
