// The receiver rebuilds `${timestamp}.${body}` from the raw request body, so the body is signed as sent.
export function sign(secret: string, timestamp: number, body: string): string {
  return new Bun.CryptoHasher("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
