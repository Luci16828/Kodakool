import { describe, expect, test } from "vitest";
import {
  listCatalogFolders,
  listSources,
  loadCatalog,
  loadInstructions,
  loadSourceText,
  loadView,
  readInstructions,
  toCatalogView,
  toCodingView,
} from "./store";
import type { CodeView } from "./store";
import type { CodingFile } from "../../coding/types";
import { DEVICE_QUOTE } from "../../../tests/fixtures";

const device = "1a65646a-1988-499d-b68e-2800fa296158"; // real "test" catalog root device

describe("listSources", () => {
  test("finds the .txt corpus under coding_source/ with folder/name/source parts", () => {
    const refs = listSources();
    expect(refs.length).toBeGreaterThan(0);
    const spd = refs.find((r) => r.source === "test/spd 1.txt");
    expect(spd).toMatchObject({ folder: "test", name: "spd 1", kind: "txt" });
  });

  test("is sorted by folder then numeric-aware name", () => {
    const refs = listSources();
    const sorted = [...refs].sort(
      (a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    expect(refs.map((r) => r.source)).toEqual(sorted.map((r) => r.source));
  });
});

describe("loadSourceText", () => {
  test("reads a txt source verbatim", async () => {
    const ref = listSources().find((r) => r.source === "test/spd 1.txt")!;
    const text = await loadSourceText(ref);
    expect(text.split("\n")[0]).toBe("Pressemitteilung");
  });
});

describe("instructions loading", () => {
  test("readInstructions returns the folder's .INSTRUCTIONS.md text", () => {
    const md = readInstructions("test");
    expect(md === null || md.length > 0).toBe(true);
    expect(readInstructions("no-such-folder")).toBeNull();
  });

  test("loadInstructions parses the frame-device catalog", () => {
    const instr = loadInstructions("test");
    expect(instr).not.toBeNull();
    expect(instr!.devices.some((d) => d.id === device)).toBe(true);
    expect(loadInstructions("no-such-folder")).toBeNull();
  });

  test("loadCatalog maps device ids to derived codes + names", () => {
    const catalog = loadCatalog("test");
    expect(catalog).not.toBeNull();
    expect(catalog!.get(device)?.code).toBe("1");
    expect(catalog!.get(device)?.name).toBe("Problemdefinition");
  });

  test("listCatalogFolders lists folders owning a catalog", () => {
    expect(listCatalogFolders()).toContain("test");
  });
});

describe("toCodingView", () => {
  const coding: CodingFile = {
    source: "test/x.txt",
    codes: [
      { device: DEVICE_QUOTE, line: 1, range: [4, 9], excerpt: "Zitat" },
      { code: "headline", line: 2, range: [0, 9], excerpt: "Mehr Teilhabe" },
    ],
  };

  test("resolves device uuids to 'code Name' via the catalog", () => {
    const catalog = new Map([
      [DEVICE_QUOTE, { code: "1.1", name: "Zitat" }],
      [device, { code: "1", name: "Problemdefinition" }],
    ]);
    const view = toCodingView(coding, catalog);
    expect(view.codes[0].code).toBe("1.1 Zitat");
    expect(view.codes[1].code).toBe("headline");
  });

  test("passes labels through and keeps unknown devices identifiable", () => {
    const view = toCodingView(coding, null);
    expect(view.codes[0].code).toBe(DEVICE_QUOTE);
    expect(view.codes[1].code).toBe("headline");
    const unknown = toCodingView(
      { source: "s", codes: [{ line: 1, range: [0, 1] as [number, number], excerpt: "x", code: "c" }] },
      new Map(),
    );
    expect(unknown.codes[0].code).toBe("c");
  });
});

describe("toCatalogView", () => {
  const code = (patch: Partial<CodeView>): CodeView => ({ line: 1, range: [0, 5], excerpt: "x", code: "c", ...patch });

  test("counts device entries and folds legacy labels into nodes with aliases", () => {
    const codes = [code({ device }), code({ code: "1 label a" }), code({ code: "1 label b" })];
    const nodes = toCatalogView("test", codes);
    const root = nodes.find((n) => n.code === "1")!;
    expect(root.count).toBe(3);
    expect(root.alias).toEqual(["1 label a", "1 label b"]);
  });

  test("surfaces unknown keys as orphan rows with counts", () => {
    const nodes = toCatalogView("test", [code({ code: "zz" }), code({ code: "zz" })]);
    const orphan = nodes.find((n) => n.code === "zz");
    expect(orphan?.count).toBe(2);
    expect(orphan?.name).toBe("");
  });

  test("labels the real test catalog's root device with a slug", () => {
    const nodes = toCatalogView("test", [code({ device })]);
    const root = nodes.find((n) => n.code === "1")!;
    expect(root.count).toBe(1);
    expect(root.slug?.short).toBeTruthy();
  });

  test("a folder without a catalog yields only orphan rows", () => {
    const nodes = toCatalogView("no-such-folder", [code({ code: "1.1 x" })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].code).toBe("1.1 x");
  });
});

describe("loadView", () => {
  test("the real coding/test file verifies against its source", async () => {
    const ref = listSources().find((r) => r.source === "test/spd 1.txt")!;
    const view = await loadView(ref);
    expect(view.status).toBe("verified");
    expect(view.codes).toBe(3);
    expect(view.errors).toEqual([]);
    expect(view.coding?.codes.map((c) => c.code)).toEqual(["document-type", "headline", "speaker-role"]);
  });

  test("sources without a coding file report uncoded", async () => {
    const ref = listSources().find((r) => r.source !== "test/spd 1.txt")!;
    const view = await loadView(ref);
    expect(view.status).toBe("uncoded");
    expect(view.coding).toBeNull();
    expect(view.codes).toBe(0);
  });
});
