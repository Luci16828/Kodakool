import { describe, expect, test } from "vitest";
import { parseCatalogFile, parseCatalogJson, parseQdc } from "./import";
import { toQdc } from "./qdc";
import { instructionsSchema } from "./instructions";
import { DEVICE_COMMENT, DEVICE_FRAME, DEVICE_QUOTE, testInstructions } from "../../tests/fixtures";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("parseCatalogJson", () => {
  test("round-trips a serialized Instructions losslessly", () => {
    const parsed = parseCatalogJson(JSON.stringify(testInstructions));
    expect(parsed).toEqual(testInstructions);
  });

  test("rejects a payload that is not an Instructions document", () => {
    expect(() => parseCatalogJson(JSON.stringify({ title: "x", devices: [] }))).toThrow();
    expect(() => parseCatalogJson("{nope")).toThrow();
  });

  test("rejects a device without a uuid id", () => {
    const raw = JSON.stringify({
      version: 1,
      title: "t",
      devices: [{ id: "not-a-uuid", name: "x", kind: "device", examples: [], children: [] }],
    });
    expect(() => parseCatalogJson(raw)).toThrow();
  });
});

describe("parseQdc", () => {
  test("round-trips the catalog tree with ids surviving via Code@guid", () => {
    const instr = parseQdc(toQdc(testInstructions, { origin: "test" }));
    expect(instructionsSchema.safeParse(instr).success).toBe(true);
    expect(instr.title).toBe("test");
    expect(instr.devices.map((d) => d.name)).toEqual(["Rahmen", "Kommentar"]);
    expect(instr.devices[0].children[0].name).toBe("Zitat");
    expect(instr.devices[0].id).toBe(DEVICE_FRAME);
    expect(instr.devices[0].children[0].id).toBe(DEVICE_QUOTE);
    expect(instr.devices[1].id).toBe(DEVICE_COMMENT);
  });

  test("is lossy by design: kind becomes device, examples drop, note+rule merge into note", () => {
    const instr = structuredClone(testInstructions);
    instr.devices[1].note = "the note";
    instr.devices[1].rule = "the rule";
    instr.devices[0].examples = [{ text: "ex", source: null }];
    const back = parseQdc(toQdc(instr, { origin: "t" }));
    expect(back.devices[1].note).toBe("the note\n\nthe rule");
    expect(back.devices[0].kind).toBe("device");
    expect(back.devices[0].examples).toEqual([]);
    expect(back.devices[0].rule).toBeUndefined();
  });

  test("strips the numeric code prefix from Code@name", () => {
    const xml = `<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes><Code guid="${DEVICE_QUOTE}" name="1.2   Zitat" isCodable="true" /></Codes></CodeBook>`;
    expect(parseQdc(xml).devices[0].name).toBe("Zitat");
  });

  test("a name that is only a numeric prefix keeps the raw label", () => {
    const xml = `<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes><Code guid="${DEVICE_QUOTE}" name="1.2" isCodable="true" /></Codes></CodeBook>`;
    expect(parseQdc(xml).devices[0].name).toBe("1.2");
  });

  test("mints a fresh uuid when guid is missing or not a uuid", () => {
    const xml = `<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes>
      <Code name="no guid" isCodable="true" />
      <Code guid="not-a-uuid" name="bad guid" isCodable="true" />
    </Codes></CodeBook>`;
    const instr = parseQdc(xml);
    expect(instr.devices[0].id).toMatch(UUID_RE);
    expect(instr.devices[1].id).toMatch(UUID_RE);
    expect(instr.devices[0].id).not.toBe(instr.devices[1].id);
  });

  test("defaults the title when CodeBook has no origin", () => {
    const xml = `<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes><Code guid="${DEVICE_QUOTE}" name="x" isCodable="true" /></Codes></CodeBook>`;
    expect(parseQdc(xml).title).toBe("imported catalog");
  });

  test("escapes XML entities in names and descriptions", () => {
    const instr = structuredClone(testInstructions);
    instr.devices[1].name = "A & B <c>";
    instr.devices[1].note = '"quoted" & <tag>';
    const back = parseQdc(toQdc(instr, { origin: "t" }));
    expect(back.devices[1].name).toBe("A & B <c>");
    expect(back.devices[1].note).toBe('"quoted" & <tag>');
  });

  test("rejects malformed XML", () => {
    expect(() => parseQdc("<CodeBook><Codes><Code></CodeBook></Codes>")).toThrow(/not well-formed XML/);
  });

  test("rejects XML without a <Codes> element", () => {
    expect(() => parseQdc('<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Nothing/></CodeBook>')).toThrow(
      /no <Codes> element/,
    );
  });

  test("rejects an empty code list", () => {
    expect(() => parseQdc('<CodeBook xmlns="urn:QDA-XML:codebook:1.0"><Codes/></CodeBook>')).toThrow(/no devices/);
  });
});

describe("parseCatalogFile", () => {
  test("dispatches on the file extension (case-insensitive)", () => {
    const qdc = toQdc(testInstructions, { origin: "test" });
    expect(parseCatalogFile("cat.qdc", qdc).title).toBe("test");
    expect(parseCatalogFile("CAT.QDC", qdc).title).toBe("test");
    expect(parseCatalogFile("cat.json", JSON.stringify(testInstructions))).toEqual(testInstructions);
    // anything not .qdc goes down the raw-JSON path
    expect(parseCatalogFile("cat.txt", JSON.stringify(testInstructions))).toEqual(testInstructions);
  });
});
