import type { Socket, SocketHandler } from "bun";
import type { SmtpConfig } from "./config";

const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export class SmtpError extends Error {
  readonly retry: boolean;
  constructor(message: string, retry: boolean) {
    super(message);
    this.name = "SmtpError";
    this.retry = retry;
  }
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface SendOpts {
  password?: string;
  // PEM of an extra trusted certificate authority; tests use it for their self-signed cert.
  ca?: string;
  timeoutMs?: number;
}

interface Reply {
  code: number;
  text: string;
}

interface Link {
  send(text: string): void;
  reply(): Promise<Reply>;
  upgrade(): void;
  close(): void;
}

function noBreaks(label: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw new SmtpError(`${label} contains a line break`, false);
  return value;
}

function address(label: string, value: string): string {
  noBreaks(label, value);
  if (/[<>\s]/.test(value) || !value.includes("@")) {
    throw new SmtpError(`${label} is not a plain address`, false);
  }
  return value;
}

// A header value must be 7-bit, so anything else goes out as an RFC 2047 encoded word.
function headerValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// Normalises line ends to CRLF and doubles a leading dot so the lone "." terminator stays unique.
function renderMessage(cfg: SmtpConfig, mail: Mail): string {
  const from = address("from", cfg.from);
  const to = address("to", mail.to);
  const subject = noBreaks("subject", mail.subject);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Bun.randomUUIDv7()}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = mail.text
    .split(/\r\n|\r|\n/)
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n.\r\n`;
}

function parseReply(buf: string): { reply: Reply; rest: string } | null {
  const lines = buf.split("\r\n");
  let used = 0;
  const texts: string[] = [];
  for (const line of lines.slice(0, -1)) {
    used += line.length + 2;
    const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!m) throw new SmtpError("malformed server reply", true);
    texts.push(m[3] ?? "");
    if (m[2] !== "-")
      return { reply: { code: Number(m[1]), text: texts.join(" ") }, rest: buf.slice(used) };
  }
  return null;
}

interface Pipe {
  socket: Socket<undefined> | null;
  buf: string;
  failure: Error | null;
  wake: (() => void) | null;
  pending: Uint8Array | null;
  // After STARTTLS the old socket keeps delivering the encrypted stream, which must not be read.
  upgraded: boolean;
}

function handlersFor(pipe: Pipe, role: "plain" | "tls"): SocketHandler<undefined> {
  const live = (): boolean => role === "tls" || !pipe.upgraded;
  const fail = (err: SmtpError): void => {
    if (!live()) return;
    pipe.failure ??= err;
    pipe.wake?.();
  };
  return {
    data(_s, chunk) {
      if (!live()) return;
      pipe.buf += chunk.toString("utf8");
      pipe.wake?.();
    },
    drain(s) {
      if (!pipe.pending || !live()) return;
      const n = s.write(pipe.pending);
      pipe.pending = n < pipe.pending.length ? pipe.pending.subarray(n) : null;
    },
    close: () => fail(new SmtpError("connection closed", true)),
    error: (_s, err) => fail(new SmtpError(`connection error: ${err.message}`, true)),
    handshake(_s, ok, err) {
      if (!ok) fail(new SmtpError(`TLS handshake failed: ${err?.message ?? "untrusted"}`, false));
    },
  };
}

async function waitForData(pipe: Pipe, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        pipe.wake = resolve;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SmtpError("timed out waiting for server", true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    pipe.wake = null;
  }
}

async function openLink(cfg: SmtpConfig, opts: SendOpts, timeoutMs: number): Promise<Link> {
  const tlsOpts = { serverName: cfg.host, ...(opts.ca ? { ca: opts.ca } : {}) };
  const pipe: Pipe = {
    socket: null,
    buf: "",
    failure: null,
    wake: null,
    pending: null,
    upgraded: false,
  };
  pipe.socket = await Bun.connect<undefined>({
    hostname: cfg.host,
    port: cfg.port,
    socket: handlersFor(pipe, "plain"),
    ...(cfg.security === "tls" ? { tls: tlsOpts } : {}),
  }).catch((err: Error) => {
    throw new SmtpError(`cannot connect: ${err.message}`, true);
  });
  return {
    send(text) {
      const bytes = new TextEncoder().encode(text);
      const n = pipe.socket?.write(bytes) ?? 0;
      if (n < bytes.length) pipe.pending = bytes.subarray(n);
    },
    async reply() {
      for (;;) {
        const parsed = parseReply(pipe.buf);
        if (parsed) {
          pipe.buf = parsed.rest;
          return parsed.reply;
        }
        if (pipe.failure) throw pipe.failure;
        await waitForData(pipe, timeoutMs);
      }
    },
    upgrade() {
      pipe.upgraded = true;
      const [, secured] = (pipe.socket as Socket<undefined>).upgradeTLS({
        tls: tlsOpts,
        socket: handlersFor(pipe, "tls"),
      });
      pipe.socket = secured;
    },
    close() {
      pipe.socket?.end();
    },
  };
}

async function command(link: Link, line: string, ok: number): Promise<Reply> {
  link.send(`${line}\r\n`);
  return expect(await link.reply(), ok);
}

function expect(reply: Reply, ok: number): Reply {
  if (reply.code === ok) return reply;
  throw new SmtpError(
    `server said ${reply.code} ${reply.text}`,
    reply.code >= 400 && reply.code < 500,
  );
}

async function authenticate(link: Link, user: string, password: string): Promise<void> {
  const token = Buffer.from(`\0${noBreaks("user", user)}\0${password}`, "utf8").toString("base64");
  link.send(`AUTH PLAIN ${token}\r\n`);
  const reply = await link.reply();
  if (reply.code !== 235) {
    throw new SmtpError(`SMTP authentication failed (${reply.code})`, reply.code < 500);
  }
}

async function session(
  link: Link,
  cfg: SmtpConfig,
  mail: Mail,
  opts: SendOpts,
  message: string,
): Promise<void> {
  expect(await link.reply(), 220);
  await command(link, "EHLO harness.local", 250);
  if (cfg.security === "starttls") {
    await command(link, "STARTTLS", 220);
    link.upgrade();
    await command(link, "EHLO harness.local", 250);
  }
  if (cfg.user && opts.password) await authenticate(link, cfg.user, opts.password);
  await command(link, `MAIL FROM:<${cfg.from}>`, 250);
  await command(link, `RCPT TO:<${mail.to}>`, 250);
  await command(link, "DATA", 354);
  link.send(message);
  expect(await link.reply(), 250);
  link.send("QUIT\r\n");
}

// Never lets the password reach a caller, whatever a server echoes back.
function scrub(err: unknown, password: string | undefined): SmtpError {
  const base = err instanceof SmtpError ? err : new SmtpError("smtp failed", true);
  if (!password) return base;
  return new SmtpError(base.message.replaceAll(password, "***"), base.retry);
}

export async function sendMail(cfg: SmtpConfig, mail: Mail, opts: SendOpts = {}): Promise<void> {
  let link: Link | null = null;
  try {
    const message = renderMessage(cfg, mail);
    if (cfg.security === "none" && cfg.user && opts.password && !LOOPBACK.has(cfg.host)) {
      throw new SmtpError(
        "refusing to send the password in clear text; use tls or starttls",
        false,
      );
    }
    link = await openLink(cfg, opts, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await session(link, cfg, mail, opts, message);
  } catch (err) {
    throw scrub(err, opts.password);
  } finally {
    link?.close();
  }
}
