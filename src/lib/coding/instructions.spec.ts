import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addChildDevice,
  addBelowDevice,
  codeIndex,
  deviceIndex,
  findDevice,
  idByCode,
  instructionsSchema,
  moveDevice,
  removeDeviceById,
  siblingsOf,
  uniqueIds,
  type FrameDevice,
} from "./instructions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(HERE, "../assets/examples/frame-devices.json");
const raw = JSON.parse(readFileSync(file, "utf8"));

describe("instructions format", () => {
  const instr = instructionsSchema.parse(raw);

  it("validates against the schema", () => {
    expect(instr.version).toBe(1);
    expect(instr.title).toBe("Kodieranweisungen");
  });

  it("has unique UUID ids and stable uuid format", () => {
    expect(uniqueIds(instr)).toBe(true);
    const ids = [...codeIndex(instr).keys()];
    expect(ids.length).toBeGreaterThan(30);
    expect(ids.some((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it("derives dotted codes from tree position", () => {
    const byCode = idByCode(instr);
    expect(byCode.has("1")).toBe(true);
    expect(byCode.has("6.9")).toBe(true);
    const find = (code: string): FrameDevice => {
      const id = byCode.get(code)!;
      const walk = (d: FrameDevice): FrameDevice | null =>
        d.id === id ? d : (d.children.map(walk).find(Boolean) ?? null);
      return instr.devices.map(walk).find(Boolean)!;
    };
    expect(find("2.1").name).toBe("Falsche Hoffnungen oder Vorstellungen vom Transsein");
    expect(find("6.9").name).toBe("Regenbogen");
    expect(find("1.1").kind).toBe("device");
    expect(find("6.9").kind).toBe("element");
  });

  it("carries a rule or note for every category and examples where the source has them", () => {
    const codes = codeIndex(instr);
    expect(codes.size).toBe(48); // 6 roots + 42 children in the test corpus
    const two = [...instr.devices[1].children];
    expect(two.every((c) => typeof c.rule === "string" && c.rule.length > 0)).toBe(true);
    const el = instr.devices[5];
    expect(el.rule).toBeTruthy();
    expect(el.children[8].examples.length).toBeGreaterThan(0);
  });

  it("resolves device name and kind from the UUID via deviceIndex", () => {
    const index = deviceIndex(instr);
    const id = idByCode(instr).get("2.1")!;
    expect(index.get(id)).toMatchObject({
      code: "2.1",
      name: "Falsche Hoffnungen oder Vorstellungen vom Transsein",
    });
    expect(index.get(idByCode(instr).get("6.9")!)?.kind).toBe("element");
  });

  it("keeps ids when only name/rule/examples are edited (id survives rename)", () => {
    const before = instr.devices[1].children[0].id;
    instr.devices[1].children[0].name = "umbenannt";
    instr.devices[1].children[0].rule = "neue Regel";
    expect(instr.devices[1].children[0].id).toBe(before);
    expect(instructionsSchema.parse(instr)).toBeTruthy();
  });

  it("accepts an optional manual tag override", () => {
    const withTag = structuredClone(instr);
    withTag.devices[0].tag = "RAH";
    expect(instructionsSchema.parse(withTag).devices[0].tag).toBe("RAH");
  });

  it("rejects empty or oversized tags", () => {
    for (const tag of ["", "x".repeat(13)]) {
      const bad = structuredClone(instr);
      bad.devices[0].tag = tag;
      expect(instructionsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("device-tree editing operations", () => {
  const dev = (id: string, children: FrameDevice[] = []): FrameDevice => ({
    id,
    name: `d-${id}`,
    kind: "device",
    examples: [],
    children,
  });
  const tree = (): FrameDevice[] => [dev("a", [dev("a1"), dev("a2")]), dev("b")];

  it("findDevice walks nested children; siblingsOf finds the owning list", () => {
    const t = tree();
    expect(findDevice(t, "a2")?.name).toBe("d-a2");
    expect(findDevice(t, "nope")).toBeNull();
    expect(siblingsOf(t, "a1")).toBe(t[0].children);
    expect(siblingsOf(t, "b")).toBe(t);
    expect(siblingsOf(t, "nope")).toBeNull();
  });

  it("addChildDevice nests under a parent or at top level", () => {
    const t = tree();
    expect(addChildDevice(t, "a1", dev("x"))).toBe(true);
    expect(t[0].children[0].children.map((c) => c.id)).toEqual(["x"]);
    expect(addChildDevice(t, null, dev("top"))).toBe(true);
    expect(t.map((d) => d.id)).toEqual(["a", "b", "top"]);
    expect(addChildDevice(t, "gone", dev("y"))).toBe(false);
  });

  it("addBelowDevice inserts directly after the anchor with kind inheritance handled by the caller", () => {
    const t = tree();
    expect(addBelowDevice(t, "a1", dev("mid"))).toBe(true);
    expect(t[0].children.map((c) => c.id)).toEqual(["a1", "mid", "a2"]);
    expect(addBelowDevice(t, "gone", dev("z"))).toBe(false);
  });

  it("removeDeviceById drops the node with its subtree and returns it", () => {
    const t = tree();
    expect(removeDeviceById(t, "a")?.children.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(t.map((d) => d.id)).toEqual(["b"]);
    expect(removeDeviceById(t, "gone")).toBeNull();
  });

  it("moveDevice lands after the target downward and before it upward", () => {
    const down = tree();
    expect(moveDevice(down, "a1", "a2")).toBe(true);
    expect(down[0].children.map((c) => c.id)).toEqual(["a2", "a1"]);
    const up = tree();
    expect(moveDevice(up, "a2", "a1")).toBe(true);
    expect(up[0].children.map((c) => c.id)).toEqual(["a2", "a1"]);
  });

  it("moveDevice refuses self-moves and cross-parent moves", () => {
    const t = tree();
    expect(moveDevice(t, "a1", "a1")).toBe(false);
    expect(moveDevice(t, "a1", "b")).toBe(false);
    expect(moveDevice(t, "gone", "a2")).toBe(false);
  });
});
