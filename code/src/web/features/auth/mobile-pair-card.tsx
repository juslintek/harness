import { useState } from "preact/hooks";
import { z } from "zod";
import {
  type MobileDeviceView,
  type MobilePairStartResult,
  mobileDeviceView,
  mobilePairStartResult,
} from "../../../shared/auth";
import { api, useLoad } from "../../api";
import { fmtTime } from "../../format";
import { ErrorLine } from "./error-line";
import { ignored } from "./me";
import { useAction } from "./use-action";

const listSchema: z.ZodType<MobileDeviceView[]> = z.array(mobileDeviceView);

export function MobilePairCard(): preact.JSX.Element {
  const devices = useLoad(() => api("/api/auth/mobile/devices", listSchema), []);
  const action = useAction();
  const [pair, setPair] = useState<MobilePairStartResult | null>(null);
  const [copied, setCopied] = useState(false);

  const startPairing = (): Promise<void> =>
    action.run(async () => {
      const result = await api("/api/auth/mobile/pair/start", mobilePairStartResult, {
        method: "POST",
        body: {},
      });
      setPair(result);
      setCopied(false);
    });

  const revoke = (id: string): Promise<void> =>
    action.run(async () => {
      await api(`/api/auth/mobile/devices/${encodeURIComponent(id)}`, ignored, {
        method: "DELETE",
      });
      devices.reload();
    });

  const copyUri = async (): Promise<void> => {
    if (!pair) return;
    await navigator.clipboard.writeText(pair.uri);
    setCopied(true);
  };

  return (
    <section aria-labelledby="mobile-devices-h">
      <h3 id="mobile-devices-h">Mobile devices</h3>
      <ErrorLine message={action.error ?? devices.error} />
      <ul class="plain">
        {devices.data?.map((d) => (
          <li key={d.id} class="card row">
            <span>
              <strong>{d.name}</strong> <span class="muted">({d.platform})</span>
              {d.current && <span class="muted"> (current device)</span>}
              <span class="muted">
                {" "}
                paired {fmtTime(d.createdAt)}, last active {fmtTime(d.lastUsedAt)}
              </span>
            </span>
            <button
              type="button"
              class="danger"
              disabled={action.busy}
              onClick={() => revoke(d.id)}
              aria-label={`Revoke device ${d.name}`}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {pair ? (
        <div class="card">
          <p>Scan or open this URI in the Harness mobile app:</p>
          <p>
            <code>{pair.uri}</code>
          </p>
          <p class="muted">
            Code: <code>{pair.code}</code> · Expires: {fmtTime(pair.expiresAt)}
          </p>
          <div class="row">
            <button type="button" onClick={copyUri}>
              {copied ? "Copied URI" : "Copy URI"}
            </button>
            <button type="button" onClick={() => setPair(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={action.busy} onClick={startPairing}>
          Pair mobile app
        </button>
      )}
    </section>
  );
}
