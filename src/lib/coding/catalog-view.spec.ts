import { describe, expect, test } from "vitest";
import { buildCatalogView, flattenCatalog, indexCatalog } from "./catalog-view";
import { DEVICE_COMMENT, DEVICE_QUOTE, testInstructions } from "../../tests/fixtures";
import type { CatalogView } from "$lib/coding/catalog-view";

function find(nodes: CatalogView[], code: string): CatalogView | undefined {
  const walk = (list: CatalogView[]): CatalogView | undefined => {
    for (const n of list) {
      if (n.code === code) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(nodes);
}

describe("buildCatalogView", () => {
  test("derives numeric codes from tree position", () => {
    const nodes = buildCatalogView(testInstructions, []);
    expect(nodes.map((n) => n.code)).toEqual(["1", "2"]);
    expect(find(nodes, "1.1")?.name).toBe("Zitat");
    expect(find(nodes, "1.1")?.kind).toBe("device");
  });

  test("counts entries by device uuid", () => {
    const nodes = buildCatalogView(testInstructions, [DEVICE_QUOTE, DEVICE_QUOTE, DEVICE_COMMENT]);
    expect(find(nodes, "1.1")?.count).toBe(2);
    expect(find(nodes, "2")?.count).toBe(1);
    expect(find(nodes, "1")?.count).toBe(0);
  });

  test("folds legacy code labels into the matching node", () => {
    const nodes = buildCatalogView(testInstructions, ["1.1 Zitat", "1 Rahmen", "2 extra label"]);
    expect(find(nodes, "1.1")?.count).toBe(1);
    expect(find(nodes, "1")?.count).toBe(1);
    expect(find(nodes, "2")?.count).toBe(1);
  });

  test("a legacy label whose numeric prefix matches no node becomes an orphan", () => {
    const nodes = buildCatalogView(testInstructions, ["2.1 ghost", "9"]);
    const ghost = nodes.find((n) => n.code === "2.1 ghost");
    const nine = nodes.find((n) => n.code === "9");
    expect(ghost?.count).toBe(1);
    expect(ghost?.name).toBe("");
    expect(nine?.count).toBe(1);
  });

  test("null catalog surfaces every key as an orphan row", () => {
    const nodes = buildCatalogView(null, [DEVICE_QUOTE, DEVICE_QUOTE, "old code"]);
    expect(nodes).toHaveLength(2);
    expect(nodes.find((n) => n.code === DEVICE_QUOTE)?.count).toBe(2);
    expect(nodes.find((n) => n.code === "old code")?.count).toBe(1);
  });

  test("manual tag wins the slug and reserves its label", () => {
    const instr = structuredClone(testInstructions);
    instr.devices[1].tag = "Z"; // Kommentar claims Zitat's natural slug
    const nodes = buildCatalogView(instr, []);
    expect(find(nodes, "2")?.slug).toEqual({ short: "Z", bold: [] });
    const zitat = find(nodes, "1.1");
    expect(zitat?.slug?.short).not.toBe("Z");
    expect(zitat?.slug?.short).toBeTruthy();
  });

  test("assigns unique heuristic slugs to every node", () => {
    const slugs = buildCatalogView(testInstructions, [])
      .flatMap((n) => [n, ...n.children])
      .map((n) => n.slug?.short);
    expect(slugs).toEqual(["R", "Z", "K"]);
  });

  test("uuid-named orphans have no slug (no letters to abbreviate)", () => {
    const nodes = buildCatalogView(null, ["11111111-1111-4111-8111-111111111111"]);
    expect(nodes[0].slug).toBeNull();
  });

  test("empty entry keys give zero counts", () => {
    const nodes = buildCatalogView(testInstructions, []);
    const flat = nodes.flatMap((n) => [n, ...n.children]);
    expect(flat.every((n) => n.count === 0)).toBe(true);
  });
});

describe("flattenCatalog/indexCatalog", () => {
  const nodes = buildCatalogView(testInstructions, ["11111111-1111-4111-8111-111111111111"]);

  test("flatten lists every node once, parents before children", () => {
    const flat = flattenCatalog(nodes);
    expect(flat.length).toBe(new Set(flat.map((n) => n.id)).size);
    const codes = flat.map((n) => n.code);
    expect(codes.indexOf("1")).toBeLessThan(codes.indexOf("1.1"));
  });

  test("the index maps ids, codes and aliases onto the catalog id", () => {
    const idx = indexCatalog(nodes);
    const zitat = flattenCatalog(nodes).find((n) => n.code === "1.1")!;
    expect(idx.displayByDevice.get(zitat.id)).toBe("1.1");
    expect(idx.nameByDevice.get(zitat.id)).toBe(zitat.name);
    expect(idx.keyToId.get(zitat.id)).toBe(zitat.id);
    expect(idx.keyToId.get("1.1")).toBe(zitat.id);
    for (const alias of zitat.alias ?? []) expect(idx.keyToId.get(alias)).toBe(zitat.id);
  });

  test("shortByCode carries the slug short labels by display code", () => {
    const idx = indexCatalog(nodes);
    expect(idx.shortByCode.get("2")).toBe("K");
    expect(idx.shortByCode.get("1.1")).toBe("Z");
  });

  test("orphans are indexed under their raw key", () => {
    const idx = indexCatalog(nodes);
    expect(idx.keyToId.get("11111111-1111-4111-8111-111111111111")).toBe("11111111-1111-4111-8111-111111111111");
  });
});
