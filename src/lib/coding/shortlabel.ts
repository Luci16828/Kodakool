export const SHORT_MAX = 5;

export interface Slug {
  short: string;
  /** positions of the letters used for `short` within the original name */
  bold: { start: number; len: number }[];
}

interface Token {
  word: string;
  upper: boolean;
  start: number;
}

function tokenize(name: string): Token[] {
  const out: Token[] = [];
  for (const m of name.matchAll(/[\p{L}]+/gu)) {
    const word = m[0];
    out.push({ word, upper: /^\p{Lu}/u.test(word[0]), start: m.index ?? 0 });
  }
  return out;
}

interface Pick {
  start: number;
  sub: string;
}

interface Cand {
  s: string;
  picks: Pick[];
}

function materialize(picks: Pick[]): Cand {
  const chosen: Pick[] = [];
  let s = "";
  for (const p of picks) {
    if (p.sub.length > SHORT_MAX) continue;
    if (chosen.length > 0 && s.length + p.sub.length > SHORT_MAX) break;
    chosen.push(p);
    s += p.sub;
    if (s.length === SHORT_MAX) break;
  }
  return { s, picks: chosen };
}

function candidates(name: string): Cand[] {
  const ts = tokenize(name);
  const uppers = ts.filter((t) => t.upper);
  if (uppers.length === 0) return [];
  const out: Cand[] = [];
  const seen = new Set<string>();
  const push = (picks: Pick[]) => {
    const c = materialize(picks);
    if (!c.s || seen.has(c.s)) return;
    seen.add(c.s);
    out.push(c);
  };
  const one = (t: Token, len = 1): Pick => ({ start: t.start, sub: t.word.slice(0, len) });

  push(uppers.map((t) => one(t)));

  const lowers = ts.filter((t) => !t.upper);
  for (let n = 1; n <= lowers.length; n++) {
    const taken = new Set(lowers.slice(0, n));
    push(ts.filter((t) => t.upper || taken.has(t)).map((t) => one(t)));
  }

  if (uppers.length > 1) {
    push([one(uppers[0], 2), ...uppers.slice(1).map((t) => one(t))]);
    push(uppers.map((t) => one(t, 2)));
    push([one(uppers[0]), ...uppers.slice(1).map((t) => one(t, 2))]);
    push([one(uppers[0], 3), ...uppers.slice(1).map((t) => one(t))]);
  }

  for (let k = 2; k <= SHORT_MAX; k++) push([one(uppers[0], k)]);

  return out;
}

export function shortSlugs(names: string[], taken: Iterable<string> = []): (Slug | null)[] {
  const used = new Set<string>();
  for (const t of taken) if (t) used.add(t.toLowerCase());
  return names.map((name) => {
    const cand = candidates(name).find((c) => !used.has(c.s.toLowerCase()));
    if (!cand) return null;
    used.add(cand.s.toLowerCase());
    return {
      short: cand.s,
      bold: cand.picks.map((p) => ({ start: p.start, len: p.sub.length })),
    };
  });
}
