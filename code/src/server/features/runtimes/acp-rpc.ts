export type Rec = Record<string, unknown>;
export type Proc = ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;

export const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const KILL_GRACE_MS = 5000;
const STDERR_TAIL = 2000;

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

// Newline-delimited JSON-RPC over the child's stdio. Writes the raw wire shapes from spikes.md
// section 3; the 2.x SDK has no client connection class to reuse.
export class Connection {
  stderrTail = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly proc: Proc;
  readonly closed: Promise<void>;

  constructor(proc: Proc, onMessage: (msg: Rec) => void) {
    this.proc = proc;
    // allSettled: a reader that throws must still fail the pending requests, and `closed` itself
    // never rejects.
    this.closed = Promise.allSettled([this.readStdout(onMessage), this.readStderr()]).then(() => {
      const err = new Error(`agent exited before a response: ${this.stderrTail.trim()}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  respond(id: unknown, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  refuse(id: unknown, method: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} not supported` } });
  }

  private write(msg: unknown): void {
    try {
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
      this.proc.stdin.flush();
    } catch {
      // The child is gone; the stdout reader reports it and rejects whatever is pending.
    }
  }

  private settle(msg: Rec): void {
    const waiter = this.pending.get(msg.id as number);
    if (!waiter) return;
    this.pending.delete(msg.id as number);
    if (msg.error === undefined) waiter.resolve(msg.result);
    else waiter.reject(new Error(String(rec(msg.error).message ?? "agent error")));
  }

  private async readStdout(onMessage: (msg: Rec) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        const msg = line === "" ? null : parseLine(line);
        if (msg === null) continue;
        if (msg.method === undefined) this.settle(msg);
        else onMessage(msg);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(
        -STDERR_TAIL,
      );
    }
  }
}

function parseLine(line: string): Rec | null {
  try {
    return rec(JSON.parse(line));
  } catch {
    return null;
  }
}

// Resolves when the promise does or after `ms`, whichever is first; the timer never outlives it.
export async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

// macOS answers EPERM, not ESRCH, when the group's leader already exited and nothing is left.
function killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw err;
  }
}

// The group goes down with the leader: srt and the agents start helpers of their own.
export async function terminate(proc: Proc): Promise<void> {
  killGroup(proc.pid, "SIGTERM");
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(KILL_GRACE_MS)]);
  if (exited !== true) killGroup(proc.pid, "SIGKILL");
  await proc.exited;
  killGroup(proc.pid, "SIGKILL");
}

export interface Clock {
  expired: Promise<"timeout">;
  touch(): void;
  stop(): void;
}

// Restarts on every touch. While `paused()` is true the limit does not fire, because a human
// approval can take longer than the idle limit.
export function idleClock(ms: number, paused: () => boolean = () => false): Clock {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fire: (v: "timeout") => void = () => {};
  const expired = new Promise<"timeout">((resolve) => {
    fire = resolve;
  });
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => (paused() ? touch() : fire("timeout")), ms);
  };
  touch();
  return { expired, touch, stop: () => clearTimeout(timer) };
}

export function abortion(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}
