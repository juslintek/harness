export function drainStops(
  stops: (() => unknown)[],
  onError: (error: unknown) => void,
): Promise<void> {
  return Promise.all(stops.map((stop) => Promise.resolve().then(stop).catch(onError))).then(
    () => {},
  );
}
