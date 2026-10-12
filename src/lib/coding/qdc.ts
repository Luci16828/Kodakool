import { codeIndex } from "./instructions";
import { buildPalette, type PaletteOptions } from "./palette";
import type { FrameDevice, Instructions } from "./instructions";

export interface QdcOptions {
  /** Written to the CodeBook `origin` attribute. */
  origin?: string;
  /** Chroma/tone adjustments so exported marker colors match the on-screen palette. */
  options?: PaletteOptions;
}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/**
 * Lossy export of a frame-device catalog to QDA-XML codebook (`.qdc`) code lists.
 * Device UUIDs are kept as `Code@guid`; derived numeric codes are prefixed to the
 * `name`; `note` and `rule` are concatenated into `<Description>` (examples are
 * dropped); nodes with children become non-codable groups.
 */
export function toQdc(instr: Instructions, opts: QdcOptions = {}): string {
  const codes = codeIndex(instr);
  const palette = buildPalette([...codes.values()], opts.options);
  const origin = opts.origin ?? "luci-bachelor";
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<CodeBook xmlns="urn:QDA-XML:codebook:1.0" xsi:schemaLocation="urn:QDA-XML:codebook:1.0 Codebook.xsd" origin="${esc(origin)}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    "<Codes>",
  ];
  const walk = (d: FrameDevice): void => {
    const code = codes.get(d.id) ?? d.id;
    const color = palette.get(code);
    const attrs = [
      `guid="${d.id}"`,
      `name="${esc(`${code} ${d.name}`)}"`,
      `isCodable="${d.children.length === 0 ? "true" : "false"}"`,
    ];
    if (color) attrs.push(`color="${color.light.marker.toUpperCase()}"`);
    const desc = [d.note, d.rule].filter((s) => s !== undefined).join("\n\n");
    if (d.children.length === 0 && desc === "") {
      lines.push(`<Code ${attrs.join(" ")} />`);
      return;
    }
    lines.push(`<Code ${attrs.join(" ")}>`);
    if (desc !== "") lines.push(`<Description>${esc(desc)}</Description>`);
    for (const c of d.children) walk(c);
    lines.push("</Code>");
  };
  for (const d of instr.devices) walk(d);
  lines.push("</Codes>", "</CodeBook>");
  return `${lines.join("\n")}\n`;
}
