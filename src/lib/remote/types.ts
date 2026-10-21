import { z } from "zod";
import { codeEntrySchema } from "$lib/coding/types";

/**
 * Wire DTOs for the optional collaboration server (server/src/types.ts is the mirror).
 * Every server response is zod-parsed at the boundary: a broken server can only fail a
 * parse, never poison the app's state.
 */

export const remoteUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
});

export const authResponseSchema = z.object({
  token: z.string().min(1),
  refresh: z.string().min(1),
  user: remoteUserSchema,
});

export const remoteProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  owner: z.string(),
  ownerName: z.string(),
  role: z.enum(["owner", "member"]),
  docs: z.number().int().min(0),
  subs: z.array(z.string()).default([]),
});

export const remoteDocSummarySchema = z.object({
  id: z.string().min(1),
  project: z.string(),
  name: z.string(),
  folder: z.string(),
  kind: z.string(),
  codes: z.number().int().min(0),
  updated: z.number(),
});

export const remoteVersionSchema = z.object({
  id: z.uuid(),
  parent: z.nullable(z.uuid()),
  time: z.number(),
  text: z.string(),
  codes: z.array(codeEntrySchema),
  label: z.string().optional(),
});

export const remoteDocSchema = remoteDocSummarySchema.extend({
  text: z.string(),
  codes: z.array(codeEntrySchema),
  versions: z.array(remoteVersionSchema),
});

export const oidcBeginSchema = z.object({
  state: z.string().min(1),
  url: z.string().min(1),
});

export type RemoteUser = z.infer<typeof remoteUserSchema>;
export type RemoteProject = z.infer<typeof remoteProjectSchema>;
export type RemoteDocSummary = z.infer<typeof remoteDocSummarySchema>;
export type RemoteVersion = z.infer<typeof remoteVersionSchema>;
export type RemoteDoc = z.infer<typeof remoteDocSchema>;
