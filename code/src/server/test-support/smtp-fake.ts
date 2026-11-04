import type { Socket, SocketHandler } from "bun";

const CERT = Bun.file(new URL("./certs/cert.pem", import.meta.url).pathname);
const KEY = Bun.file(new URL("./certs/key.pem", import.meta.url).pathname);

export interface SmtpFakeOpts {
  // "implicit" wraps the whole connection in TLS, "starttls" advertises and honours STARTTLS.
  tls?: "implicit" | "starttls";
  // Reply to the end of DATA, e.g. "550 mailbox unavailable".
  dataReply?: string;
  // Reply to RCPT TO.
  rcptReply?: string;
  // Close the connection as soon as DATA is accepted.
  dropInData?: boolean;
  // Never answer the greeting.
  silent?: boolean;
}

interface ReceivedMail {
  from: string;
  to: string[];
  // The message as the client sent it, dot-stuffing already undone.
  data: string;
}

export interface SmtpFake {
  port: number;
  mails: ReceivedMail[];
  // Decoded payload of every AUTH PLAIN seen.
  auths: string[];
  // Every command line seen, in order.
  commands: string[];
  cert: string;
  stop(): void;
}

interface Session {
  buf: string;
  inData: boolean;
  data: string[];
  from: string;
  to: string[];
}

type Sock = Socket<undefined>;

interface Server {
  opts: SmtpFakeOpts;
  out: Pick<SmtpFake, "mails" | "auths" | "commands">;
  tls: { cert: string; key: string };
  sessions: WeakMap<object, Session>;
  handlers: SocketHandler<undefined>;
}

const reply = (socket: Sock, text: string): void => {
  socket.write(`${text}\r\n`);
};

// After STARTTLS the same session continues on the upgraded socket.
function upgrade(srv: Server, socket: Sock): void {
  const session = srv.sessions.get(socket);
  const [, secured] = socket.upgradeTLS({ tls: srv.tls, socket: srv.handlers });
  srv.sessions.delete(socket);
  if (session) srv.sessions.set(secured, session);
}

function onCommand(srv: Server, socket: Sock, s: Session, cmd: string): void {
  srv.out.commands.push(cmd);
  const verb = cmd.split(" ")[0]?.toUpperCase();
  const address = /<(.*)>/.exec(cmd)?.[1] ?? "";
  if (verb === "EHLO") {
    reply(socket, "250-fake.test");
    if (srv.opts.tls === "starttls") reply(socket, "250-STARTTLS");
    reply(socket, "250 AUTH PLAIN");
  } else if (verb === "STARTTLS") {
    reply(socket, "220 go ahead");
    // Without the flush the reply would be queued behind the handshake and arrive encrypted.
    socket.flush();
    upgrade(srv, socket);
  } else if (verb === "AUTH") {
    srv.out.auths.push(Buffer.from(cmd.split(" ")[2] ?? "", "base64").toString("utf8"));
    reply(socket, "235 ok");
  } else if (verb === "MAIL") {
    s.from = address;
    reply(socket, "250 ok");
  } else if (verb === "RCPT") {
    s.to.push(address);
    reply(socket, srv.opts.rcptReply ?? "250 ok");
  } else {
    otherCommand(srv, socket, s, verb);
  }
}

function otherCommand(srv: Server, socket: Sock, s: Session, verb: string | undefined): void {
  if (verb === "DATA") {
    s.inData = true;
    reply(socket, "354 go");
    if (srv.opts.dropInData) socket.end();
  } else if (verb === "QUIT") {
    reply(socket, "221 bye");
    socket.end();
  } else reply(socket, "500 what");
}

function onDataLine(srv: Server, socket: Sock, s: Session, text: string): void {
  if (text !== ".") {
    s.data.push(text.startsWith(".") ? text.slice(1) : text);
    return;
  }
  s.inData = false;
  const answer = srv.opts.dataReply ?? "250 queued";
  if (answer.startsWith("250")) {
    srv.out.mails.push({ from: s.from, to: s.to, data: s.data.join("\r\n") });
  }
  s.data = [];
  s.to = [];
  reply(socket, answer);
}

function consume(srv: Server, socket: Sock, s: Session): void {
  for (let i = s.buf.indexOf("\r\n"); i >= 0; i = s.buf.indexOf("\r\n")) {
    const text = s.buf.slice(0, i);
    s.buf = s.buf.slice(i + 2);
    if (s.inData) onDataLine(srv, socket, s, text);
    else onCommand(srv, socket, s, text);
  }
}

export async function startSmtpFake(opts: SmtpFakeOpts = {}): Promise<SmtpFake> {
  const cert = await CERT.text();
  const out = { mails: [], auths: [], commands: [] };
  const srv: Server = {
    opts,
    out,
    tls: { cert, key: await KEY.text() },
    sessions: new WeakMap(),
    handlers: {
      open(socket) {
        if (srv.sessions.has(socket)) return;
        srv.sessions.set(socket, { buf: "", inData: false, data: [], from: "", to: [] });
        if (!opts.silent) reply(socket, "220 fake.test ESMTP");
      },
      data(socket, chunk) {
        const s = srv.sessions.get(socket);
        if (!s) return;
        s.buf += chunk.toString("utf8");
        consume(srv, socket, s);
      },
      error() {},
    },
  };
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: srv.handlers,
    ...(opts.tls === "implicit" ? { tls: srv.tls } : {}),
  });
  return { port: server.port, ...out, cert, stop: () => server.stop(true) };
}
