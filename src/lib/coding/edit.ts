import type { CodeEntry } from "./types";

/** Cumulative character offsets of each line's first character (line 0 = 0). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 0-based line containing the character position `pos` (must be < text.length). */
export function lineAt(starts: number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Deterministic document id for a coding entry, stable across re-imports. */
export function entryId(source: string, entry: CodeEntry): string {
  if (entry.uid !== undefined) return entry.uid;
  const key = entry.device ?? entry.code ?? "";
  const end = entry.endLine !== undefined ? `#${entry.endLine}` : "";
  return `${source}|${entry.line}${end}|${entry.range[0]}-${entry.range[1]}|${key}`;
}

/**
 * Span (line/endLine/range/excerpt) for exclusive global offsets [from, to),
 * derived from `starts`/`text`. Trims a trailing newline. This is the pure
 * position half of {@link entryFromOffsets}, reusable to re-anchor an existing
 * entry's identity onto edited text without losing device/code/note.
 */
export function offsetsSpan(
  starts: number[],
  text: string,
  from: number,
  to: number,
): Pick<CodeEntry, "line" | "endLine" | "range" | "excerpt"> {
  let end = to;
  while (end > from + 1 && text[end - 1] === "\n") end--;
  const line = lineAt(starts, from);
  const endLine = lineAt(starts, end - 1);
  const base = {
    line: line + 1,
    range: [from - starts[line], end - starts[endLine]] as [number, number],
    excerpt: text.slice(from, end),
  };
  return endLine === line ? base : { ...base, endLine: endLine + 1 };
}

/**
 * Convert exclusive global character offsets [from, to) into a coding entry
 * spanning the source lines between them; `excerpt` is the verbatim span.
 */
export function entryFromOffsets(
  source: string,
  starts: number[],
  text: string,
  from: number,
  to: number,
  device: string,
  uid?: string,
): CodeEntry {
  const entry: CodeEntry = { device, ...offsetsSpan(starts, text, from, to) };
  if (uid !== undefined) entry.uid = uid;
  return entry;
}

/**
 * Canonical coding-state fingerprint for the dirty check: content only (uid is
 * identity, not content), key order fixed, entries order-independent — stored
 * snapshots come back from RxDB with a different key order than `deriveCodes` writes.
 */
export function codesKey(list: CodeEntry[]): string {
  const items = list.map((e) =>
    JSON.stringify([
      e.device ?? null,
      e.code ?? null,
      e.line,
      e.endLine ?? null,
      e.range[0],
      e.range[1],
      e.excerpt,
      e.note ?? null,
    ]),
  );
  return JSON.stringify(items.sort());
}

/**
 * Coding the same span with the same device twice is redundant: content equality
 * (device/code + line/endLine + range). The uid keeps an entry's identity across
 * text edits, but a fresh uid per click would let the same span be coded over and over.
 */
export function isDuplicateEntry(entries: CodeEntry[], entry: CodeEntry): boolean {
  return entries.some(
    (e) =>
      (e.device ?? e.code) === (entry.device ?? entry.code) &&
      e.line === entry.line &&
      (e.endLine ?? e.line) === (entry.endLine ?? entry.line) &&
      e.range[0] === entry.range[0] &&
      e.range[1] === entry.range[1],
  );
}
