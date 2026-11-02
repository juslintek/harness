const MAX_WORDS = 64;
// Quotes and substitutions make the text ambiguous, so only plain words are expanded.
const PLAIN = /^[^\s$`"'\\]*$/;

class TooMany extends Error {}

interface Group {
  open: number;
  close: number;
  commas: number[];
}

function groupAt(word: string, open: number): Group | null {
  let depth = 0;
  const commas: number[] = [];
  for (let i = open; i < word.length; i++) {
    const c = word[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return { open, close: i, commas };
    else if (c === "," && depth === 1) commas.push(i);
  }
  return null;
}

function expand(word: string, budget: { left: number }): string[] {
  for (let open = word.indexOf("{"); open >= 0; open = word.indexOf("{", open + 1)) {
    const g = groupAt(word, open);
    if (!g) return [word];
    if (g.commas.length === 0) continue;
    const bounds = [g.open, ...g.commas, g.close];
    const pre = word.slice(0, g.open);
    const post = word.slice(g.close + 1);
    return bounds.slice(0, -1).flatMap((start, k) => {
      if (--budget.left < 0) throw new TooMany();
      return expand(pre + word.slice(start + 1, bounds[k + 1]) + post, budget);
    });
  }
  return [word];
}

// `{a,b}` lists are static; sequences (`{1..3}`) and anything too large stay as one word.
export function expandBraces(word: string): string[] {
  if (!word.includes("{") || !PLAIN.test(word)) return [word];
  try {
    return expand(word, { left: MAX_WORDS });
  } catch (e) {
    if (e instanceof TooMany) return [word];
    throw e;
  }
}
