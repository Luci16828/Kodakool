import { codingFileSchema, ELLIPSIS } from "./types.ts";
import type { CodeEntry, CodingFile } from "./types.ts";

/** Split an excerpt into its verbatim segments around "[...]". */
export function excerptSegments(excerpt: string): string[] {
  return excerpt.split(ELLIPSIS);
}

export interface EntryError {
  index: number;
  entry: CodeEntry;
  message: string;
}

/**
 * Verify one code entry against the source text.
 * The entry spans from `range[0]` on `line` to `range[1]` on `endLine`
 * (defaults to `line`; entries may cross line breaks). Entries may overlap.
 * The excerpt must match the source exactly: without "[...]" the excerpt equals
 * the source range verbatim; with "[...]" each segment must appear in order
 * inside the range, anchored to its start and end, with at least one omitted
 * character between consecutive segments. Returns an error message or null.
 */
export function verifyEntry(sourceText: string, entry: CodeEntry): string | null {
  const lines = sourceText.split("\n");
  if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > lines.length) {
    return `line ${entry.line} is out of range (1-${lines.length})`;
  }
  const endLine = entry.endLine ?? entry.line;
  if (!Number.isInteger(endLine) || endLine < entry.line || endLine > lines.length) {
    return `endLine ${entry.endLine} is invalid (must be an integer between ${entry.line} and ${lines.length})`;
  }
  const [start, end] = entry.range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return `range [${start}, ${end}) must be integers`;
  }
  const startLine = lines[entry.line - 1];
  const endLineText = lines[endLine - 1];
  if (start < 0 || start >= startLine.length) {
    return `range start ${start} is invalid for line ${entry.line} (length ${startLine.length})`;
  }
  if (end < 0 || end > endLineText.length) {
    return `range end ${end} is invalid for line ${endLine} (length ${endLineText.length})`;
  }
  if (endLine === entry.line && end <= start) {
    return `range [${start}, ${end}) is invalid for line ${entry.line} (length ${startLine.length})`;
  }
  const span =
    endLine === entry.line
      ? startLine.slice(start, end)
      : [startLine.slice(start), ...lines.slice(entry.line, endLine - 1), endLineText.slice(0, end)].join("\n");
  const segments = excerptSegments(entry.excerpt);
  if (segments.some((s) => s.length === 0)) {
    return `excerpt must not start or end with ${ELLIPSIS} or contain adjacent ${ELLIPSIS}`;
  }
  if (segments.length === 1) {
    return entry.excerpt === span ? null : "excerpt does not match the text at this range";
  }
  let pos = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const idx = i === 0 ? (span.startsWith(seg) ? 0 : -1) : span.indexOf(seg, pos + 1);
    if (idx === -1) {
      return `segment ${i + 1} (${JSON.stringify(seg)}) does not appear in order within the range`;
    }
    if (i === segments.length - 1 && idx + seg.length !== span.length) {
      return `last segment must end exactly at range end (found it ending at offset ${idx + seg.length} of ${span.length})`;
    }
    pos = idx + seg.length;
  }
  return null;
}

/** Verify a whole coding file against its source text. Entries may overlap. */
export function verifyCoding(sourceText: string, coding: CodingFile): EntryError[] {
  const errors: EntryError[] = [];
  coding.codes.forEach((entry, index) => {
    const message = verifyEntry(sourceText, entry);
    if (message) {
      errors.push({ index, entry, message });
    }
  });
  return errors;
}

/** Parse and type-check a coding JSON payload against `codingFileSchema`. Throws on shape errors. */
export function parseCodingJson(raw: string): CodingFile {
  const data: unknown = JSON.parse(raw);
  const result = codingFileSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const at = first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
    throw new Error(`invalid coding file${at}: ${first.message}`);
  }
  return result.data;
}
