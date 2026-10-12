import { describe, expect, test } from "vitest";
import { instructionsSchema } from "./instructions";
import { buildPalette } from "./palette";
import { toQdc } from "./qdc";

const instr = instructionsSchema.parse({
  version: 1,
  title: "Test codebook",
  devices: [
    {
      id: "29f7e5d1-10fc-420e-8a1d-b09d19fc2976",
      name: 'Männer < & "Machos"',
      kind: "device",
      note: "Rahmen 1",
      rule: "Alles, was <x> betrifft.",
      children: [
        {
          id: "751fdbb0-3b9f-4425-ada2-c36943f3d607",
          name: "Blatt",
          kind: "element",
          children: [{ id: "c4047b2e-0be7-41c0-9513-ea277ffca4b2", name: "Zweig", kind: "element" }],
        },
      ],
    },
  ],
});

describe("toQdc", () => {
  const xml = toQdc(instr, { origin: "test" });

  test("declares the QDA-XML codebook namespace", () => {
    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('xmlns="urn:QDA-XML:codebook:1.0"');
    expect(xml).toContain('origin="test"');
    expect(xml.trimEnd().endsWith("</CodeBook>")).toBe(true);
  });

  test("keeps device ids as guids and prefixes names with derived codes", () => {
    expect(xml).toContain(
      '<Code guid="29f7e5d1-10fc-420e-8a1d-b09d19fc2976" name="1 Männer &lt; &amp; &quot;Machos&quot;" isCodable="false"',
    );
    expect(xml).toContain('<Code guid="751fdbb0-3b9f-4425-ada2-c36943f3d607" name="1.1 Blatt" isCodable="false"');
    expect(xml).toContain('<Code guid="c4047b2e-0be7-41c0-9513-ea277ffca4b2" name="1.1.1 Zweig" isCodable="true"');
  });

  test("parents are non-codable groups, leaves are codable and self-closing", () => {
    expect(xml).toContain("</Code>");
    expect(xml).toMatch(/<Code guid="c4047b2e[^/]*\/>/);
  });

  test("note and rule concatenate into one escaped Description", () => {
    expect(xml).toContain("<Description>Rahmen 1\n\nAlles, was &lt;x&gt; betrifft.</Description>");
  });

  test("every code gets an uppercase hex palette color", () => {
    const palette = buildPalette(["1", "1.1", "1.1.1"]);
    for (const [code, c] of palette) {
      expect(xml).toContain(`color="${c.light.marker.toUpperCase()}"`);
      expect(`color="${c.light.marker.toUpperCase()}"`).toMatch(/^color="#[0-9A-F]{6}"$/);
    }
  });
});
