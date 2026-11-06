/**
 * Word-level diff of what the bot drafted vs what Matt sent, for display.
 * `s` is the text as sent (as drafted, for del); same parts also carry the
 * draft's own spelling in `a`.
 */
export type DiffPart = { t: "same" | "del" | "ins"; s: string; a?: string };

export function wordDiff(a: string, b: string): DiffPart[] {
  const x = a.split(/(\s+)/).filter(Boolean);
  const y = b.split(/(\s+)/).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9$]/g, "");
  // LCS table over tokens (whitespace tokens included, so spacing survives)
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      L[i][j] = norm(x[i]) === norm(y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (t: DiffPart["t"], s: string, a?: string) => {
    const last = out.at(-1);
    if (last && last.t === t) {
      last.s += s;
      if (a !== undefined) last.a = (last.a ?? "") + a;
    } else out.push(a === undefined ? { t, s } : { t, s, a });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (norm(x[i]) === norm(y[j])) {
      push("same", y[j], x[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) push("del", x[i++]);
    else push("ins", y[j++]);
  }
  while (i < x.length) push("del", x[i++]);
  while (j < y.length) push("ins", y[j++]);
  return out;
}
