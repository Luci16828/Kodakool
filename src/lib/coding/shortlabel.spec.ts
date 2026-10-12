import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shortSlugs } from "./shortlabel.ts";

const shorts = (names: string[]): (string | null)[] => shortSlugs(names).map((s) => s?.short ?? null);

describe("shortSlugs", () => {
  it("takes the capitalized initials", () => {
    expect(shorts(["Regierung bzw. Ampelkoalition"])).toEqual(["RA"]);
  });

  it("resolves collisions with a lowercase letter", () => {
    expect(shorts(["Regierung bzw. Ampelkoalition", "Regierung bzw. Ampelkoalition"])).toEqual(["RA", "RbA"]);
  });

  it("resolves further collisions with two-letter groups", () => {
    expect(
      shorts(["Regierung bzw. Ampelkoalition", "Regierung bzw. Ampelkoalition", "Regierung bzw. Ampelkoalition"]),
    ).toEqual(["RA", "RbA", "ReA"]);
  });

  it("clamps to 5 characters", () => {
    for (const s of shorts(["Gender Affirming Care Medicine Act"])) expect(s?.length ?? 0).toBeLessThanOrEqual(5);
  });

  it("falls back to null when all candidates collide", () => {
    const names = Array.from({ length: 20 }, () => "Regierung bzw. Ampelkoalition");
    expect(shorts(names).filter((s) => s === null).length).toBeGreaterThan(0);
  });

  it("handles single-word names via prefixes", () => {
    expect(shorts(["Transaktivisten", "Transideologie", "Translobby"])).toEqual(["T", "Tr", "Tra"]);
  });

  it("reserves manually overridden tags before auto slugs", () => {
    const withTaken = (names: string[], taken: string[]) => shortSlugs(names, taken).map((s) => s?.short ?? null);
    expect(withTaken(["Zitat", "Zusammenfassung"], ["Z"])).toEqual(["Zi", "Zu"]);
  });

  it("produces a unique slug for every frame device in the catalog", () => {
    const instr = JSON.parse(
      readFileSync(new URL("../../../coding/test/.INSTRUCTIONS.json", import.meta.url), "utf8"),
    ) as { devices: { name: string; children?: { name: string; children?: never }[] }[] };
    const names: string[] = [];
    const walk = (ds: { name: string; children?: { name: string }[] }[]): void => {
      for (const d of ds) {
        names.push(d.name);
        walk(d.children ?? []);
      }
    };
    walk(instr.devices);
    expect(names.length).toBeGreaterThan(40);
    expect(shorts(names).filter((s) => s === null)).toEqual([]);
  });
});
