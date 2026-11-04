// Each search bumps the generation; a response applies only while its generation is still the
// newest, so a slow earlier search cannot overwrite a later one.
export function latestGuard(): () => () => boolean {
  let generation = 0;
  return () => {
    const mine = ++generation;
    return () => mine === generation;
  };
}
