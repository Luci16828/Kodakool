import { z } from "zod";

export const ELLIPSIS = "[...]";

export const codeEntrySchema = z
  .object({
    /** stable client-minted id; once present it pins entry identity across text edits (RxDB primary key) */
    uid: z.uuid().optional(),
    /** legacy code label; coding files with a device catalog reference `device` UUIDs instead */
    code: z.string().min(1).optional(),
    /** UUID of the frame device in coding/<folder>/.INSTRUCTIONS.json this code refers to */
    device: z.uuid().optional(),
    /** 1-based line number in the source text */
    line: z.int(),
    /** 1-based line the span ends on; defaults to `line` (entry may cross line breaks) */
    endLine: z.int().optional(),
    /** character range [start, end): start offsets within `line`, end offsets within `endLine` */
    range: z.tuple([z.int(), z.int()]),
    /** verbatim text of the range; collapsed middle parts replaced by "[...]" */
    excerpt: z.string().min(1),
    note: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.code === undefined && entry.device === undefined) {
      ctx.issues.push({
        code: "custom",
        input: entry,
        message: 'entry needs a "code" label or a "device" UUID',
      });
    }
    if (entry.endLine !== undefined && entry.endLine < entry.line) {
      ctx.issues.push({
        code: "custom",
        input: entry,
        path: ["endLine"],
        message: `endLine ${entry.endLine} must be >= line ${entry.line}`,
      });
    }
  });

export const articleVersionSchema = z.object({
  /** ISO timestamp the snapshot was taken */
  savedAt: z.string(),
  /** optional user label for an explicit named version */
  label: z.string().optional(),
  /** article body at snapshot time */
  text: z.string(),
  codes: z.array(codeEntrySchema),
});

export const codingFileSchema = z.object({
  /**
   * Stable article id. For app-owned (pasted/uploaded) articles this is `"<folder>/<name>"`;
   * for legacy coding_source-derived files it is the path relative to coding_source/, e.g. "test/spd 1.txt".
   */
  source: z.string().min(1),
  /** app-owned article body; absent for legacy coding_source-derived files (whose text lives in coding_source/) */
  text: z.string().optional(),
  /** append-only snapshots of prior text+codes; present only for app-owned articles */
  versions: z.array(articleVersionSchema).optional(),
  codes: z.array(codeEntrySchema),
});

export type CodeEntry = z.infer<typeof codeEntrySchema>;
export type CodingFile = z.infer<typeof codingFileSchema>;
export type ArticleVersion = z.infer<typeof articleVersionSchema>;
