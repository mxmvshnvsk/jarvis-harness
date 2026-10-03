/**
 * Minimal unified diff for artifact versions (ADR-0005 §3). Line-based LCS; artifacts are
 * specs and plans, not source trees, so O(n·m) with a size cap is fine.
 */
export const DIFF_LINE_CAP = 5000;

export function unifiedDiff(
  before: string,
  after: string,
  nameBefore = "a",
  nameAfter = "b",
): string | undefined {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) return undefined;
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] =
        a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: Array<{ kind: " " | "-" | "+"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i += 1;
      j += 1;
    } else if (((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number)) {
      ops.push({ kind: "-", line: a[i] as string });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ kind: "-", line: a[i] as string });
  for (; j < m; j += 1) ops.push({ kind: "+", line: b[j] as string });
  if (!ops.some((o) => o.kind !== " ")) return "";

  // Group changes into hunks with 3 lines of context, merging hunks whose gap is small.
  const context = 3;
  const ranges: Array<[number, number]> = [];
  let k = 0;
  while (k < ops.length) {
    if ((ops[k] as { kind: string }).kind === " ") {
      k += 1;
      continue;
    }
    let end = k;
    while (end < ops.length && (ops[end] as { kind: string }).kind !== " ") end += 1;
    const last = ranges[ranges.length - 1];
    if (last && k - last[1] <= context * 2) last[1] = end;
    else ranges.push([k, end]);
    k = end;
  }

  const out: string[] = [`--- ${nameBefore}`, `+++ ${nameAfter}`];
  // Map op index → line numbers in a and b before that op.
  const aAt: number[] = [];
  const bAt: number[] = [];
  let aLine = 1;
  let bLine = 1;
  for (const op of ops) {
    aAt.push(aLine);
    bAt.push(bLine);
    if (op.kind !== "+") aLine += 1;
    if (op.kind !== "-") bLine += 1;
  }
  for (const [from, to] of ranges) {
    const start = Math.max(0, from - context);
    const end = Math.min(ops.length, to + context);
    const hunk = ops.slice(start, end);
    const aCount = hunk.filter((o) => o.kind !== "+").length;
    const bCount = hunk.filter((o) => o.kind !== "-").length;
    out.push(`@@ -${aAt[start]},${aCount} +${bAt[start]},${bCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.line}`);
  }
  return `${out.join("\n")}\n`;
}
