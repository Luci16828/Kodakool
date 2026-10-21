import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ArticlePage from "../routes/text/[folder]/[name]/+page.svelte";
import { getLocalCatalog, saveLocalCatalog } from "$lib/local/local-api";
import { parseCatalogFile, parseCatalogJson, parseQdc } from "$lib/coding/import";
import { toQdc } from "$lib/coding/qdc";
import {
  DEVICE_COMMENT,
  DEVICE_FRAME,
  DEVICE_QUOTE,
  resetArticles,
  seedArticle,
  testInstructions,
  uploadTo,
} from "./fixtures";

const FOLDER = "test";

let lastRender: ReturnType<typeof render> | undefined;

afterEach(() => {
  lastRender?.unmount();
  lastRender = undefined;
});

beforeEach(async () => {
  await resetArticles();
});

describe("frame-device catalog export/import", () => {
  it("round-trips a .json export losslessly", () => {
    const back = parseCatalogJson(JSON.stringify(testInstructions));
    expect(back).toEqual(testInstructions);
  });

  it("round-trips a .qdc export: ids, names and nesting survive", () => {
    const back = parseQdc(toQdc(testInstructions, { origin: FOLDER }));
    expect(back.title).toBe(FOLDER);
    expect(back.devices.map((d) => [d.id, d.name])).toEqual([
      [DEVICE_FRAME, "Rahmen"],
      [DEVICE_COMMENT, "Kommentar"],
    ]);
    expect(back.devices[0].children.map((d) => [d.id, d.name])).toEqual([[DEVICE_QUOTE, "Zitat"]]);
  });

  it("merges note+rule into note on .qdc import (lossy)", () => {
    const instr = {
      ...testInstructions,
      devices: [
        {
          ...testInstructions.devices[0],
          note: "framing",
          rule: "only quotes",
          children: [
            {
              ...testInstructions.devices[0].children[0],
              examples: [{ text: "example", source: null }],
            },
          ],
        },
        testInstructions.devices[1],
      ],
    };
    const back = parseQdc(toQdc(instr, { origin: FOLDER }));
    expect(back.devices[0].note).toContain("framing");
    expect(back.devices[0].note).toContain("only quotes");
    expect(back.devices[0].rule).toBeUndefined();
    // examples are dropped by the .qdc format
    expect(back.devices[0].children[0].examples).toEqual([]);
  });

  it("parseCatalogFile dispatches by extension and rejects garbage", () => {
    expect(parseCatalogFile("x.json", JSON.stringify(testInstructions)).title).toBe("Test catalog");
    expect(parseCatalogFile("x.qdc", toQdc(testInstructions)).devices.length).toBe(2);
    expect(() => parseCatalogFile("x.qdc", "<Codes><oops")).toThrow(/qdc/);
    expect(() => parseCatalogFile("x.json", "{}")).toThrow();
  });

  it("imports a catalog through the aside import button (local override)", async () => {
    await seedArticle({ project: FOLDER, name: "spd 1", text: "Ein Zitat im Text." });
    await saveLocalCatalog(FOLDER, testInstructions);
    lastRender = render(ArticlePage, { data: { folder: FOLDER, name: "spd 1" } }, { wrapper: ColorProvider });
    await expect.element(page.getByRole("textbox")).toBeInTheDocument();

    const imported = {
      ...testInstructions,
      title: "imported",
      devices: [testInstructions.devices[0], { ...testInstructions.devices[1], name: "Stellungnahme" }],
    };
    uploadTo(".catfile", new File([JSON.stringify(imported)], "devices.json", { type: "application/json" }));

    await expect
      .poll(async () => (await getLocalCatalog(FOLDER))?.devices.map((d) => d.name))
      .toEqual(["Rahmen", "Stellungnahme"]);
    await expect.element(page.getByText("Stellungnahme").first()).toBeInTheDocument();
    await expect.element(page.getByText(/imported 2 top-level devices/)).toBeInTheDocument();
  });
});
