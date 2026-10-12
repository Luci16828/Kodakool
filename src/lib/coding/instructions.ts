import { z } from "zod";

export const exampleSchema = z.object({
  text: z.string().min(1),
  source: z.string().nullable().optional().default(null),
});

export interface FrameDevice {
  id: string;
  name: string;
  kind: "device" | "element";
  note?: string | undefined;
  rule?: string | undefined;
  /** manual override for the auto-generated short tag shown on chips/sidebar */
  tag?: string | undefined;
  examples: { text: string; source: string | null }[];
  children: FrameDevice[];
}

export const frameDeviceSchema: z.ZodType<FrameDevice> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    name: z.string().min(1),
    kind: z.enum(["device", "element"]),
    note: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    tag: z.string().min(1).max(12).optional(),
    examples: z.array(exampleSchema).default([]),
    children: z.array(frameDeviceSchema).default([]),
  }),
);

export const instructionsSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  devices: z.array(frameDeviceSchema).min(1),
});

export type Instructions = z.infer<typeof instructionsSchema>;

/** Circular-free validation: every device id must be unique across the whole tree. */
export function uniqueIds(instr: Instructions): boolean {
  const seen = new Set<string>();
  const walk = (d: FrameDevice): boolean => {
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return d.children.every(walk);
  };
  return instr.devices.every(walk);
}

/** Derived numeric code per device id, e.g. "1.2.3" (1-based position, recursive). */
export function codeIndex(instr: Instructions): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: FrameDevice, prefix: string): void => {
    out.set(d.id, prefix);
    d.children.forEach((c, i) => walk(c, `${prefix}.${i + 1}`));
  };
  instr.devices.forEach((d, i) => walk(d, `${i + 1}`));
  return out;
}

/** Device details per id: derived numeric code, name, and kind. */
export function deviceIndex(
  instr: Instructions,
): Map<string, { code: string; name: string; kind: "device" | "element" }> {
  const out = new Map<string, { code: string; name: string; kind: "device" | "element" }>();
  const walk = (d: FrameDevice, prefix: string): void => {
    out.set(d.id, { code: prefix, name: d.name, kind: d.kind });
    d.children.forEach((c, i) => walk(c, `${prefix}.${i + 1}`));
  };
  instr.devices.forEach((d, i) => walk(d, `${i + 1}`));
  return out;
}

/** Reverse lookup: numeric code -> device id. */
export function idByCode(instr: Instructions): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, code] of codeIndex(instr)) out.set(code, id);
  return out;
}
