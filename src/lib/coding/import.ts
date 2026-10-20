import { instructionsSchema, UUID_RE, type FrameDevice, type Instructions } from "./instructions";

/** Parse a `.json` frame-device export (the raw `Instructions` shape, lossless). */
export function parseCatalogJson(text: string): Instructions {
  return instructionsSchema.parse(JSON.parse(text));
}

/**
 * Parse a `.qdc` QDA-XML codebook (as written by `toQdc`) back into an
 * `Instructions` tree. Lossy by nature: `examples` are gone and `note`/`rule`
 * come back merged into `note`; device `kind` defaults to "device".
 * Device UUIDs survive the round-trip via `Code@guid`.
 */
export function parseQdc(text: string): Instructions {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("invalid .qdc: not well-formed XML");
  const codes = doc.querySelector("Codes");
  if (!codes) throw new Error("invalid .qdc: no <Codes> element");
  const parseCode = (el: Element): FrameDevice => {
    const guid = el.getAttribute("guid") ?? "";
    const raw = el.getAttribute("name") ?? "device";
    // toQdc prefixes the derived numeric code ("1.2 Label") — strip it back off
    const name = raw.replace(/^\d+(?:\.\d+)*\s+/, "") || raw;
    const desc = el.querySelector(":scope > Description")?.textContent?.trim() ?? "";
    const node: FrameDevice = {
      id: UUID_RE.test(guid) ? guid : crypto.randomUUID(),
      name,
      kind: "device",
      examples: [],
      children: [...el.querySelectorAll(":scope > Code")].map(parseCode),
    };
    if (desc !== "") node.note = desc;
    return node;
  };
  const devices = [...codes.querySelectorAll(":scope > Code")].map(parseCode);
  if (devices.length === 0) throw new Error("invalid .qdc: no devices");
  const title = doc.documentElement.getAttribute("origin") ?? "imported catalog";
  return instructionsSchema.parse({ version: 1, title, devices });
}

/** Pick the parser by file name (`.json` / `.qdc`). */
export function parseCatalogFile(filename: string, text: string): Instructions {
  if (/\.qdc$/i.test(filename)) return parseQdc(text);
  return parseCatalogJson(text);
}
