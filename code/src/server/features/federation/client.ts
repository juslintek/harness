import type { Database } from "bun:sqlite";
import { ensureInstance } from "../../db/db";
import { DomainError } from "../../route-kit";
import { privateKeyB64 } from "./keys";
import { getPeer, type PeerRow } from "./peers-repo";
import { signRequest } from "./sign";

const TIMEOUT_MS = 15_000;

export interface SignedInit {
  method?: string;
  json?: unknown;
  timeoutMs?: number;
}

// The body is serialised once and the same bytes are signed and sent. The peer is re-read so a
// revocation made after the caller loaded its row still stops the call.
export async function signedFetch(
  db: Database,
  home: string,
  peer: PeerRow,
  path: string,
  init: SignedInit = {},
): Promise<Response> {
  const current = getPeer(db, peer.id);
  if (!current || current.revokedAt !== null) throw new DomainError("peer is revoked");
  const url = new URL(path, current.url);
  if (url.origin !== new URL(current.url).origin) throw new DomainError("invalid path");
  const body = init.json === undefined ? "" : JSON.stringify(init.json);
  const method = init.method ?? (init.json === undefined ? "GET" : "POST");
  const signed = signRequest(privateKeyB64(home), {
    instance: ensureInstance(db),
    audience: current.id,
    method,
    pathWithQuery: url.pathname + url.search,
    body,
  });
  return fetch(url, {
    method,
    headers: {
      "x-harness-instance": signed.instance,
      "x-harness-timestamp": signed.timestamp,
      "x-harness-nonce": signed.nonce,
      "x-harness-signature": signed.signature,
      ...(init.json === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === "" ? {} : { body }),
    redirect: "error",
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
  });
}

// The peer sent more than we agreed to read; a smaller page may still fit.
export class BodyTooLarge extends DomainError {
  constructor() {
    super("peer sent a page over the size limit");
  }
}

// Stops reading as soon as the body is known to pass `max`, so a hostile peer cannot make us hold it.
export async function readJsonCapped(res: Response, max: number): Promise<unknown> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel();
    throw new BodyTooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > max) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new DomainError("peer sent an unreadable page");
  }
}
