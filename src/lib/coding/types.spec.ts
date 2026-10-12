import { describe, expect, test } from "vitest";
import { articleVersionSchema, codeEntrySchema, codingFileSchema } from "./types";

const device = "847c4079-1958-49fe-92e8-c7547308be18";
const uid = "9a3d1f4c-7b52-4e16-9c0a-5d2e8f1b6a34";

const base = { line: 2, range: [0, 9] as [number, number], excerpt: "Anke Hennig" };

describe("codeEntrySchema", () => {
  test("accepts a device-only entry", () => {
    expect(codeEntrySchema.safeParse({ ...base, device }).success).toBe(true);
  });

  test("accepts a legacy code-label-only entry", () => {
    expect(codeEntrySchema.safeParse({ ...base, code: "2.1 speaker-role" }).success).toBe(true);
  });

  test("accepts both identities plus all optional fields", () => {
    const r = codeEntrySchema.safeParse({ ...base, device, code: "2.1", uid, endLine: 3, note: "x" });
    expect(r.success).toBe(true);
  });

  test("rejects an entry with neither code nor device", () => {
    const r = codeEntrySchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(/needs a "code" label or a "device" UUID/);
  });

  test("rejects an empty code label", () => {
    expect(codeEntrySchema.safeParse({ ...base, code: "" }).success).toBe(false);
  });

  test("rejects an empty excerpt", () => {
    expect(codeEntrySchema.safeParse({ ...base, device, excerpt: "" }).success).toBe(false);
  });

  test("rejects non-uuid uid and device", () => {
    expect(codeEntrySchema.safeParse({ ...base, device, uid: "nope" }).success).toBe(false);
    expect(codeEntrySchema.safeParse({ ...base, device: "not-a-uuid" }).success).toBe(false);
  });

  test("rejects non-integer line/range values", () => {
    expect(codeEntrySchema.safeParse({ ...base, device, line: 1.5 }).success).toBe(false);
    expect(codeEntrySchema.safeParse({ ...base, device, range: [0.5, 9] }).success).toBe(false);
    expect(codeEntrySchema.safeParse({ ...base, device, range: [0] }).success).toBe(false);
  });

  test("rejects endLine below line", () => {
    const r = codeEntrySchema.safeParse({ ...base, device, endLine: 1 });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["endLine"]);
  });

  test("accepts endLine equal to line", () => {
    expect(codeEntrySchema.safeParse({ ...base, device, endLine: 2 }).success).toBe(true);
  });
});

describe("articleVersionSchema", () => {
  test("requires savedAt + text + codes, label optional", () => {
    expect(articleVersionSchema.safeParse({ savedAt: "t", text: "x", codes: [] }).success).toBe(true);
    expect(articleVersionSchema.safeParse({ savedAt: "t", text: "x", codes: [], label: "v1" }).success).toBe(true);
    expect(articleVersionSchema.safeParse({ text: "x", codes: [] }).success).toBe(false);
    expect(articleVersionSchema.safeParse({ savedAt: "t", text: "x" }).success).toBe(false);
  });

  test("version codes go through the entry schema", () => {
    const r = articleVersionSchema.safeParse({ savedAt: "t", text: "x", codes: [base] });
    expect(r.success).toBe(false);
  });
});

describe("codingFileSchema", () => {
  test("accepts a legacy coding_source file", () => {
    const r = codingFileSchema.safeParse({ source: "test/spd 1.txt", codes: [{ ...base, code: "headline" }] });
    expect(r.success).toBe(true);
  });

  test("accepts an app-owned file with text + versions", () => {
    const r = codingFileSchema.safeParse({
      source: "proj/doc",
      text: "body",
      versions: [{ savedAt: "s", text: "old", codes: [{ ...base, code: "c" }] }],
      codes: [{ ...base, device }],
    });
    expect(r.success).toBe(true);
  });

  test("rejects an empty source", () => {
    expect(codingFileSchema.safeParse({ source: "", codes: [] }).success).toBe(false);
  });

  test("rejects a missing codes array", () => {
    expect(codingFileSchema.safeParse({ source: "s" }).success).toBe(false);
  });

  test("propagates entry identity errors", () => {
    const r = codingFileSchema.safeParse({ source: "s", codes: [base] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path[0]).toBe("codes");
  });
});
