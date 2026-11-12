// A 401 sends the visitor to the sign-in page; the hash they came for is replayed after sign-in so a
// notification deep link survives it.
let returnHash: string | null = null;

export function rememberReturn(hash: string): void {
  returnHash = hash;
}

export function takeReturn(): string {
  const hash = returnHash || "#/";
  returnHash = null;
  return hash;
}
