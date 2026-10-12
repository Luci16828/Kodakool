/**
 * PDF → text extraction shared by the client (upload flow + PDF view, via dynamic
 * import so unpdf stays out of the main bundle) and the server verify pipeline.
 * Deterministic: the same PDF bytes always produce the same text AND the same
 * span offsets, so coding offsets and page-rectangle mapping stay stable.
 */

export interface PdfText {
  /** extracted text; one entry per PDF page, pages separated by a blank line */
  text: string;
  pages: number;
}

/** one pdf.js text item mapped onto the extracted text */
export interface PdfSpan {
  /** [start, end) offsets into the extracted text */
  start: number;
  end: number;
  /** 1-based PDF page */
  page: number;
  /** PDF user space, origin bottom-left */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfDoc extends PdfText {
  spans: PdfSpan[];
}

/**
 * Soft-break unwrap — single revert switch (set to `false` to get the raw
 * layout-line text back). Justified PDF lines wrap mid-sentence, which put a
 * hard `\n` inside sentences; every such break became a paragraph boundary for
 * smart select. When enabled, a line break is replaced with a **space** when it
 * looks like a wrap: the previous line ends with a lowercase letter or comma
 * and the next line starts with a lowercase letter. Sentence-final
 * punctuation, hyphens (no de-hyphenation), capitals, digits and blank lines
 * (page separators) keep their break. The swap is 1:1 — the text length never
 * changes, so all span offsets and existing entry offsets stay valid.
 */
export const JOIN_SOFT_BREAKS = true;

/** mid-sentence wrap: `…word\nword…` / `…word,\nword…` (Unicode-aware, German umlauts included) */
const SOFT_BREAK = /(?<=\p{Ll}|,)\n(?=\p{Ll})/gu;

export async function extractPdfDoc(data: Uint8Array | ArrayBuffer): Promise<PdfDoc> {
  const { extractTextItems } = await import("unpdf");
  const src = data instanceof Uint8Array ? data : new Uint8Array(data);
  // pdf.js transfers (detaches) the buffer it is handed — always give it a private copy
  const bytes = new Uint8Array(src.byteLength);
  bytes.set(src);
  const { totalPages, items } = await extractTextItems(bytes);
  const spans: PdfSpan[] = [];
  let base = 0; // absolute offset of the current page's text in the joined document
  const pages = items.map((pageItems, pageIndex) => {
    let out = "";
    let prev: { x: number; width: number; eol: boolean } | null = null;
    for (const it of pageItems) {
      // pdf.js splits a visual line into items; insert a space where the PDF
      // left a horizontal gap instead of encoding one (gap spaces get no span)
      if (prev !== null && !prev.eol && it.x > prev.x + prev.width + 1 && !out.endsWith(" ") && !it.str.startsWith(" "))
        out += " ";
      const start = base + out.length;
      out += it.str;
      spans.push({
        start,
        end: base + out.length,
        page: pageIndex + 1,
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
      });
      if (it.hasEOL) out += "\n";
      prev = { x: it.x, width: it.width, eol: it.hasEOL };
    }
    const pageText = out.replace(/\s+$/, "");
    base += pageText.length + 2; // + the "\n\n" page separator
    return pageText;
  });
  let joined = pages.join("\n\n");
  if (JOIN_SOFT_BREAKS) joined = joined.replace(SOFT_BREAK, " ");
  // global leading trim shifts every span (trailing trim cannot touch span ends)
  const lead = joined.length - joined.trimStart().length;
  if (lead > 0)
    for (const s of spans) {
      s.start = Math.max(0, s.start - lead);
      s.end = Math.max(0, s.end - lead);
    }
  return { text: joined.trim(), pages: totalPages, spans: spans.filter((s) => s.start < s.end) };
}

export async function extractPdfText(data: Uint8Array | ArrayBuffer): Promise<PdfText> {
  const { text, pages } = await extractPdfDoc(data);
  return { text, pages };
}
