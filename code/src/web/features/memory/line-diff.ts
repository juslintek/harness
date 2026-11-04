export interface DiffLine {
  op: " " | "+" | "-";
  line: string;
}

// The table is (n+1)*(m+1) cells; past this many lines a whole-block replace is cheaper than the memory.
const MAX_LINES = 2000;

const split = (text: string): string[] => (text === "" ? [] : text.split("\n"));

// lcs[i][j] is the longest common run of x[i..] and y[j..], stored flat.
function lcsTable(x: string[], y: string[]): (i: number, j: number) => number {
  const w = y.length + 1;
  const cells = new Uint16Array((x.length + 1) * w);
  const at = (i: number, j: number): number => cells[i * w + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      cells[i * w + j] =
        x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  return at;
}

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = split(a);
  const y = split(b);
  if (x.length > MAX_LINES || y.length > MAX_LINES) {
    return [
      ...x.map((line): DiffLine => ({ op: "-", line })),
      ...y.map((line): DiffLine => ({ op: "+", line })),
    ];
  }
  const at = lcsTable(x, y);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    const left = x[i];
    const right = y[j];
    if (left !== undefined && left === right) {
      out.push({ op: " ", line: left });
      i++;
      j++;
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      out.push({ op: "-", line: left });
      i++;
    } else if (right !== undefined) {
      out.push({ op: "+", line: right });
      j++;
    }
  }
  return out;
}
