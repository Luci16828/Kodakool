import type { CodeEntry } from "./types.ts";

export interface TextToken {
  text: string;
  /** index into the codes array passed to buildTokens, empty for uncoded text */
  codes: number[];
  /** subset of codes whose entry starts exactly at this token */
  starts: number[];
}

/**
 * Split the source text into consecutive tokens, marking which codes cover them.
 * Entries may overlap (tokens then list several code indices) and may cross line
 * breaks (`endLine`). Entries with invalid offsets are skipped.
 */
export function buildTokens(sourceText: string, codes: CodeEntry[]): TextToken[] {
  const lines = sourceText.split("\n");
  interface Clip {
    start: number;
    end: number;
    index: number;
    entryStart: boolean;
  }
  const clips: Clip[][] = lines.map(() => []);

  codes.forEach((entry, index) => {
    if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > lines.length) return;
    const endLine = entry.endLine ?? entry.line;
    if (!Number.isInteger(endLine) || endLine < entry.line || endLine > lines.length) return;
    const [start, end] = entry.range;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const perLine: Clip[] = [];
    for (let l = entry.line; l <= endLine; l++) {
      const s = l === entry.line ? start : 0;
      const e = l === endLine ? end : lines[l - 1].length;
      if (s < 0 || e > lines[l - 1].length || s >= e) return;
      perLine.push({ start: s, end: e, index, entryStart: l === entry.line });
    }
    perLine.forEach((clip, k) => clips[entry.line - 1 + k].push(clip));
  });

  const tokens: TextToken[] = [];
  const push = (text: string, code: number[], starts: number[] = []) => {
    if (text.length > 0) tokens.push({ text, codes: code, starts });
  };

  lines.forEach((lineText, i) => {
    const boundaries = new Set<number>([0, lineText.length]);
    for (const clip of clips[i]) {
      boundaries.add(clip.start);
      boundaries.add(clip.end);
    }
    const points = [...boundaries].sort((a, b) => a - b);
    for (let p = 0; p < points.length - 1; p++) {
      const s = points[p];
      const e = points[p + 1];
      const covering = clips[i]
        .filter((clip) => clip.start <= s && clip.end >= e)
        .map((clip) => clip.index)
        .sort((a, b) => a - b);
      const starts = clips[i]
        .filter((clip) => clip.entryStart && clip.start === s)
        .map((clip) => clip.index)
        .sort((a, b) => a - b);
      push(lineText.slice(s, e), covering, starts);
    }
    if (i < lines.length - 1) push("\n", []);
  });

  return tokens;
}

/** Deterministic hue per code label for highlighting. */
export function codeHue(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return Math.abs(h % 360);
}
