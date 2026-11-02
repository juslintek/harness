export class ShellParseError extends Error {}

export type Tok = { t: "word"; v: string; subs: string[] } | { t: "op"; v: string };

interface Lexer {
  src: string;
  i: number;
  word: string;
  inWord: boolean;
  toks: Tok[];
  wordSubs: string[];
  heredocs: Heredoc[];
}

interface Heredoc {
  delim: string;
  strip: boolean;
}

// Only a quoted delimiter makes the body static text; an unquoted one expands substitutions.
const QUOTED_HEREDOC = /^<<(-?)[ \t]*(['"])([^'"\n]+)\2/;

function skipBody(src: string, from: number, doc: Heredoc): number {
  let i = from;
  while (i < src.length) {
    const nl = src.indexOf("\n", i);
    const line = src.slice(i, nl < 0 ? src.length : nl);
    i = nl < 0 ? src.length : nl + 1;
    if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delim) return i;
  }
  throw new ShellParseError("unterminated heredoc");
}

function skipDouble(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src.startsWith("$(", i)) i = closeParen(src, i + 2);
    else if (src[i] === '"') return i;
  }
  throw new ShellParseError("unterminated double quote");
}

// Heredoc operator at i: remembers the delimiter and returns the index of its last character.
function noteHeredoc(src: string, i: number, pending: Heredoc[]): number {
  const doc = QUOTED_HEREDOC.exec(src.slice(i, i + 200));
  if (!doc) return i;
  pending.push({ delim: doc[3] as string, strip: doc[1] === "-" });
  return i + doc[0].length - 1;
}

// Jumps over quotes, escapes and heredoc bodies; returns i unchanged for any other character.
function skipOpaque(src: string, i: number, pending: Heredoc[]): number {
  const c = src[i];
  if (c === "<") return noteHeredoc(src, i, pending);
  if (c === "\\") return i + 1;
  if (c === "'") return src.indexOf("'", i + 1);
  if (c === '"') return skipDouble(src, i + 1);
  if (c !== "\n") return i;
  let end = i;
  for (const d of pending.splice(0)) end = skipBody(src, end + 1, d) - 1;
  return end;
}

function closeParen(src: string, from: number): number {
  let depth = 1;
  const pending: Heredoc[] = [];
  for (let i = from; i < src.length && i >= 0; i++) {
    const next = skipOpaque(src, i, pending);
    if (next !== i) i = next;
    else if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return i;
  }
  throw new ShellParseError("unterminated substitution");
}

function closeBacktick(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  throw new ShellParseError("unterminated backtick");
}

function flush(lx: Lexer): void {
  if (lx.inWord) lx.toks.push({ t: "word", v: lx.word, subs: lx.wordSubs });
  lx.wordSubs = [];
  lx.word = "";
  lx.inWord = false;
}

function pushOp(lx: Lexer, v: string, width = v.length): void {
  flush(lx);
  lx.toks.push({ t: "op", v });
  lx.i += width;
}

function literal(lx: Lexer): void {
  lx.word += lx.src[lx.i];
  lx.inWord = true;
  lx.i++;
}

// The substituted text is kept verbatim in the word so a later `eval` / `sh -c` re-parse sees it.
function readSubst(lx: Lexer, open: string): void {
  const start = lx.i + open.length;
  const end = open === "`" ? closeBacktick(lx.src, start) : closeParen(lx.src, start);
  const inner = lx.src.slice(start, end);
  lx.wordSubs.push(inner);
  lx.word += open + inner + (open === "`" ? "`" : ")");
  lx.inWord = true;
  lx.i = end + 1;
}

function readSingle(lx: Lexer): void {
  const end = lx.src.indexOf("'", lx.i + 1);
  if (end < 0) throw new ShellParseError("unterminated single quote");
  lx.word += lx.src.slice(lx.i + 1, end);
  lx.inWord = true;
  lx.i = end + 1;
}

function doubleEscape(lx: Lexer): void {
  const next = lx.src[lx.i + 1] ?? "";
  if (next !== "" && '$`"\\'.includes(next)) {
    lx.word += next;
    lx.i += 2;
  } else if (next === "\n") lx.i += 2;
  else literal(lx);
}

function readDouble(lx: Lexer): void {
  lx.inWord = true;
  lx.i++;
  while (lx.i < lx.src.length) {
    const c = lx.src[lx.i];
    if (c === '"') {
      lx.i++;
      return;
    }
    if (lx.src.startsWith("$(", lx.i)) readSubst(lx, "$(");
    else if (c === "`") readSubst(lx, "`");
    else if (c === "\\") doubleEscape(lx);
    else literal(lx);
  }
  throw new ShellParseError("unterminated double quote");
}

function readRedirect(lx: Lexer): void {
  if (lx.inWord && /^\d+$/.test(lx.word)) {
    lx.word = "";
    lx.inWord = false;
  } else flush(lx);
  lx.i++;
  if (lx.src[lx.i] === ">" || lx.src[lx.i] === "|") lx.i++;
  else if (lx.src[lx.i] === "&") {
    lx.i++;
    const fd = /^(\d+|-)/.exec(lx.src.slice(lx.i));
    if (fd) {
      lx.i += fd[0].length;
      return;
    }
  }
  lx.toks.push({ t: "op", v: ">" });
}

function opAmp(lx: Lexer): void {
  if (lx.src.startsWith("&&", lx.i)) pushOp(lx, "&&");
  else if (lx.src.startsWith("&>", lx.i)) {
    lx.i++;
    readRedirect(lx);
  } else pushOp(lx, "&");
}

function opPipe(lx: Lexer): void {
  if (lx.src.startsWith("||", lx.i)) pushOp(lx, "||");
  else if (lx.src.startsWith("|&", lx.i)) pushOp(lx, "|", 2);
  else pushOp(lx, "|");
}

function opLess(lx: Lexer): void {
  if (lx.src.startsWith("<(", lx.i) && !lx.inWord) readSubst(lx, "<(");
  else if (lx.src.startsWith("<<<", lx.i)) pushOp(lx, "<<<");
  else if (lx.src.startsWith("<<", lx.i)) quotedHeredoc(lx);
  else pushOp(lx, "<");
}

// `cat <<'EOF'` reads static text: model it as a here-string so shells still ask and `cat` does not.
function quotedHeredoc(lx: Lexer): void {
  const m = QUOTED_HEREDOC.exec(lx.src.slice(lx.i, lx.i + 200));
  if (!m) throw new ShellParseError("heredoc");
  lx.heredocs.push({ delim: m[3] as string, strip: m[1] === "-" });
  flush(lx);
  lx.toks.push({ t: "op", v: "<<<" }, { t: "word", v: "", subs: [] });
  lx.i += m[0].length;
}

function newline(lx: Lexer): void {
  pushOp(lx, ";", 1);
  for (const d of lx.heredocs.splice(0)) lx.i = skipBody(lx.src, lx.i, d);
}

function opGreater(lx: Lexer): void {
  if (lx.src.startsWith(">(", lx.i) && !lx.inWord) readSubst(lx, ">(");
  else readRedirect(lx);
}

function backslash(lx: Lexer): void {
  const next = lx.src[lx.i + 1];
  if (next !== undefined && next !== "\n") {
    lx.word += next;
    lx.inWord = true;
  }
  lx.i += 2;
}

function readBraceVar(lx: Lexer): void {
  const end = lx.src.indexOf("}", lx.i);
  if (end < 0) throw new ShellParseError("unterminated ${");
  lx.word += lx.src.slice(lx.i, end + 1);
  lx.inWord = true;
  lx.i = end + 1;
}

function dollar(lx: Lexer): void {
  if (lx.src.startsWith("$(", lx.i)) readSubst(lx, "$(");
  else if (lx.src.startsWith("${", lx.i)) readBraceVar(lx);
  else literal(lx);
}

function hash(lx: Lexer): void {
  if (lx.inWord) {
    literal(lx);
    return;
  }
  const nl = lx.src.indexOf("\n", lx.i);
  lx.i = nl < 0 ? lx.src.length : nl;
}

function space(lx: Lexer): void {
  flush(lx);
  lx.i++;
}

const BY_CHAR = new Map<string, (lx: Lexer) => void>([
  [" ", space],
  ["\t", space],
  ["\n", newline],
  [";", (lx) => pushOp(lx, ";", lx.src.startsWith(";;", lx.i) ? 2 : 1)],
  ["(", (lx) => pushOp(lx, "(", 1)],
  [")", (lx) => pushOp(lx, ")", 1)],
  ["\\", backslash],
  ["'", readSingle],
  ['"', readDouble],
  ["`", (lx) => readSubst(lx, "`")],
  ["$", dollar],
  ["#", hash],
  ["&", opAmp],
  ["|", opPipe],
  ["<", opLess],
  [">", opGreater],
]);

export function lex(src: string): Tok[] {
  const lx: Lexer = { src, i: 0, word: "", inWord: false, toks: [], wordSubs: [], heredocs: [] };
  while (lx.i < src.length) (BY_CHAR.get(src[lx.i] as string) ?? literal)(lx);
  flush(lx);
  if (lx.heredocs.length > 0) throw new ShellParseError("unterminated heredoc");
  return lx.toks;
}
