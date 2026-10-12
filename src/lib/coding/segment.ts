/** Pure text segmentation for smart (logical) selection. All offsets are 0-based. */

export interface Span {
  from: number;
  to: number;
}

const WORD = /[\p{L}\p{N}*]/u;
/** sentence terminators */
const TERM = /[.!?…]/;
/** trailing punctuation + closing marks after a word or quoted span */
const TRAIL = /[.,;:!?…'"“”‚’»›)\]]/;
/** closing delimiters that may sit directly after a sentence terminator */
const CLOSESPAN = /["“”‚’«»‹›()\[\]]/;
/** delimiters/whitespace that can precede a single-letter abbreviation token */
const ABBREV_PREV = /[\s([{«"'„‚‛]/;
/** opening delimiters (+ markdown blockquote markers): a sentence may start right after one */
const OPENSPAN = /[„"'«‹([{>]/;

/** paragraph bounds; `hard` treats every newline as a boundary (PDF text lines) */
function paraStart(text: string, pos: number, hard = false): number {
  const sep = hard ? "\n" : "\n\n";
  const i = text.lastIndexOf(sep, Math.max(0, pos - 1));
  return i === -1 ? 0 : i + sep.length;
}

function paraEnd(text: string, pos: number, hard = false): number {
  const sep = hard ? "\n" : "\n\n";
  const i = text.indexOf(sep, pos);
  return i === -1 ? text.length : i;
}
/** what a sentence is expected to start with (after terminators/whitespace) */
const SENT_START = /[A-ZÄÖÜ0-9„«"'(\[>]/;
/** recognised quote/bracket delimiter pairs */
const PAIRS: Array<[string, string]> = [
  ["\u201E", "\u201C"], // „ “
  ["\u201A", "\u2019"], // ‚ ’
  ["\u00AB", "\u00BB"], // « »
  ["\u2039", "\u203A"], // ‹ ›
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ['"', '"'],
  ["'", "'"],
];

/** last non-whitespace char before `from` is punctuation; a crossed blank line counts as one; blockquote markers are transparent */
function precededByPunct(text: string, from: number): boolean {
  let i = from - 1;
  let nl = 0;
  while (i >= 0 && (/\s/.test(text[i]) || text[i] === ">")) {
    if (text[i] === "\n") nl++;
    i--;
  }
  if (nl >= 2) return true; // a paragraph break acts like a period
  return i >= 0 && /[.,;:!?…„“‚’«»‹›"()\[\]{}]/.test(text[i]);
}

function trailingRun(text: string, to: number): number {
  let t = to;
  while (t < text.length && TRAIL.test(text[t])) t++;
  return t;
}

/** expand both ends to whole words; end punctuation only when start is preceded by it */
export function snapWords(text: string, from: number, to: number): Span {
  let f = from;
  let t = to;
  while (f > 0 && WORD.test(text[f - 1])) f--;
  while (t < text.length && WORD.test(text[t])) t++;
  if (f >= t) return { from: f, to: t };
  if (precededByPunct(text, f)) t = trailingRun(text, t);
  return { from: f, to: t };
}

/**
 * Delimiter span (quote/bracket) containing `pos`, innermost wins, delimiters
 * included; trailing punctuation only when the span start is preceded by it.
 */
export function elementSpan(text: string, pos: number, hard = false): Span | null {
  // delimiters must sit inside the same paragraph as pos
  const pStart = paraStart(text, pos, hard);
  const pEnd = paraEnd(text, pos, hard);
  let best: Span | null = null;
  for (const [o, c] of PAIRS) {
    const open = text.lastIndexOf(o, Math.min(pos, pEnd) - 1);
    if (open < pStart) continue;
    if (o === "'" && open > 0 && WORD.test(text[open - 1]) && WORD.test(text[open + 1])) continue; // intra-word apostrophe
    const close = text.indexOf(c, open + 1);
    if (close < pos || close >= pEnd) continue;
    if (best !== null && open <= best.from) continue;
    best = { from: open, to: close + 1 };
  }
  if (best === null) return null;
  // a quote wrapping several sentences is not a sensible unit: demote it so the
  // clicked inner sentence wins
  for (let i = best.from + 1; i < best.to - 1; i++) {
    if (termRun(text, i) !== null) return null;
  }
  const to = precededByPunct(text, best.from) ? trailingRun(text, best.to) : best.to;
  return { ...best, to };
}

/**
 * If `text[i]` ends a sentence, return the offset just after the terminator
 * and any closing marks; null otherwise (abbreviations like "z. B." are skipped).
 */
function termRun(text: string, i: number): number | null {
  if (!TERM.test(text[i])) return null;
  // an abbreviation period is one that follows a single-letter token (z. B., u. a.);
  // a period after a real word ends the sentence, and an ordinal period ("6.") only
  // does when the next word looks like a sentence start (the SENT_START check below
  // keeps "nach dem 6. mal" one sentence but splits "am 6. Januar")
  if (text[i] === "." && /\p{L}/u.test(text[i - 1] ?? "") && !WORD.test(text[i - 2] ?? "")) return null;
  let e = i + 1;
  while (e < text.length && (CLOSESPAN.test(text[e]) || TERM.test(text[e]))) e++;
  let j = e;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j < text.length && !SENT_START.test(text[j])) return null;
  return e;
}

/**
 * Sentence containing `pos`, bounded by the paragraph (a blank line counts as a
 * period). The terminator is included only when the sentence start is preceded
 * by punctuation, an opening delimiter, or a paragraph break (e.g. `When the
 * thing goes` keeps its period in `for. When ...`).
 */
export function sentenceSpan(text: string, pos: number, hard = false): Span {
  const start = paraStart(text, pos, hard);
  const end = paraEnd(text, pos, hard);
  // pos sits exactly on a hard break: paraStart skips past it while paraEnd
  // stops at it → clamp to an empty span instead of returning an inverted one
  if (start > end) return { from: end, to: end };
  let from = start;
  for (let i = pos - 1; i >= start; i--) {
    const e = termRun(text, i);
    if (e !== null) {
      from = e;
      break;
    }
  }
  while (from < end && /\s/.test(text[from])) from++;
  while (from < end && OPENSPAN.test(text[from])) {
    from++;
    while (from < end && /\s/.test(text[from])) from++;
  }
  let termEnd = end;
  let termStart = end;
  for (let i = Math.max(pos, from); i < end; i++) {
    const e = termRun(text, i);
    if (e !== null) {
      termStart = i;
      termEnd = e;
      break;
    }
  }
  let to = precededByPunct(text, from) ? termEnd : termStart;
  // a closing delimiter only belongs to this sentence if its pair opened inside
  // the span: a quote continued from further up is not fully selected, so its
  // closer is dropped (`... hätte?“` → `... hätte?`). Ambiguous closers (straight
  // quotes, apostrophes) glued to a word stay — they may be intra-word marks
  while (to > from && CLOSESPAN.test(text[to - 1])) {
    const pair = PAIRS.find((pc) => pc[1] === text[to - 1]);
    const glued = TERM.test(text[to - 2] ?? "") || CLOSESPAN.test(text[to - 2] ?? "");
    const unambiguous = pair !== undefined && pair[0] !== pair[1] && pair[1] !== "\u2019";
    if (!glued && !unambiguous) break;
    if (pair !== undefined && text.lastIndexOf(pair[0], to - 2) >= from) break;
    to--;
  }
  while (to > from && /\s/.test(text[to - 1])) to--;
  return { from, to };
}
