import { z } from "zod";

/**
 * Wire DTOs (zod). The client mirrors these in src/lib/remote/types.ts —
 * keep both sides in sync when the API evolves.
 */

/** a coding entry as the app stores it (mirrors src/lib/coding/types.ts) */
export const codeEntrySchema = z.object({
  device: z.uuid().optional(),
  code: z.string().min(1).max(64).optional(),
  uid: z.uuid().optional(),
  line: z.number().int().min(1),
  endLine: z.number().int().min(1).optional(),
  range: z.array(z.number().int().min(0)).length(2),
  excerpt: z.string().max(4000),
  note: z.string().max(4000).optional(),
});

/** a frame-device catalog (mirrors src/lib/coding/instructions.ts, recursive) */
export const instructionsSchema: z.ZodType<Instructions> = z.lazy(() =>
  z.object({
    version: z.number().int().min(1),
    title: z.string().max(200),
    devices: z.array(frameDeviceSchema),
  }),
);

export const frameDeviceSchema: z.ZodType<FrameDevice> = z.lazy(() =>
  z.object({
    id: z.uuid(),
    name: z.string().min(1).max(200),
    kind: z.enum(["device", "element"]),
    note: z.string().max(2000).optional(),
    rule: z.string().max(2000).optional(),
    tag: z.string().min(1).max(12).optional(),
    // the app's wire shape: examples are {text, source} objects (bare strings accepted too)
    examples: z
      .array(z.union([z.string().max(2000), z.object({ text: z.string().max(2000), source: z.string().nullable() })]))
      .default([]),
    children: z.array(frameDeviceSchema).default([]),
  }),
);

export interface FrameDevice {
  id: string;
  name: string;
  kind: "device" | "element";
  note?: string;
  rule?: string;
  tag?: string;
  examples: (string | { text: string; source: string | null })[];
  children: FrameDevice[];
}

export interface Instructions {
  version: number;
  title: string;
  devices: FrameDevice[];
}

export const versionSchema = z.object({
  id: z.uuid(),
  parent: z.nullable(z.uuid()),
  time: z.number().int(),
  text: z.string(),
  codes: z.array(codeEntrySchema),
  label: z.string().max(200).optional(),
});

/* ----- request bodies ----- */

export const registerBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(100).optional(),
});

export const loginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export const oidcBeginBody = z.object({
  iss: z.string().min(8).max(300),
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().min(8).max(300),
});

export const oidcExchangeBody = z.object({
  state: z.string().min(8).max(100),
  code: z.string().min(1).max(2000),
  redirectUri: z.string().min(8).max(300),
});

export const refreshBody = z.object({ refresh: z.string().min(16).max(200) });

export const projectBody = z.object({ name: z.string().min(1).max(200) });

export const docBody = z.object({
  // generous cap: the app never enforces a name length (legacy Dexie contract)
  name: z.string().min(1).max(2000),
  folder: z.string().max(400).optional(),
  text: z.string().max(2_000_000).optional(),
  kind: z.enum(["text", "pdf"]).optional(),
});

export const docPatchBody = z.object({
  name: z.string().min(1).max(2000).optional(),
  folder: z.string().max(400).optional(),
  text: z.string().max(2_000_000).optional(),
  codes: z.array(codeEntrySchema).optional(),
  versions: z.array(versionSchema).max(200).optional(),
  /** move the document into another project (by name) */
  project: z.string().min(1).max(200).optional(),
});

export const subsBody = z.object({ subs: z.array(z.string().max(400)).max(500) });

export const shareBody = z.object({ email: z.string().email().max(200) });

export const catalogBody = z.object({ data: instructionsSchema.nullable() });

export const versionBody = z.object({
  text: z.string().max(2_000_000),
  codes: z.array(codeEntrySchema),
  label: z.string().max(200).optional(),
  parent: z.nullable(z.uuid()).optional(),
});

export const labelBody = z.object({ label: z.string().max(200) });
