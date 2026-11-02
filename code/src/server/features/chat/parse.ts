const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
// Same shape as handleSchema in shared/orgs.ts. The lookbehind keeps email addresses out.
const MENTION = /(?<![A-Za-z0-9_@.-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/g;
const TASK = /(?<![\w&])#(\d{1,9})(?!\w)/g;

export function parseMessage(body: string): { handles: string[]; taskNumbers: number[] } {
  const text = body.replace(CODE, " ");
  const handles = [...text.matchAll(MENTION)].map((m) => m[1] as string);
  const numbers = [...text.matchAll(TASK)].map((m) => Number(m[1]));
  return { handles: [...new Set(handles)], taskNumbers: [...new Set(numbers)] };
}
