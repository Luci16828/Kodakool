import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import PdfView from "$lib/coding/PdfView.svelte";
import { buildPdf } from "$lib/coding/pdf-sample";
import { extractPdfDoc } from "$lib/coding/pdf";

function mk(id: string, from: number, to: number, label: string, color = "#ff0000") {
  return {
    id,
    from,
    to,
    devices: [id],
    faded: false,
    hot: false,
    color,
    colorD: color,
    colorHot: color,
    colorHotD: color,
    label,
    tagless: false,
    on: "#000000",
    onD: "#ffffff",
  };
}

async function mount(
  marks: ReturnType<typeof mk>[],
  opts: {
    armed?: boolean;
    smart?: boolean;
    lines?: string[];
    onselect?: (r: { from: number; to: number } | null) => void;
    onadd?: (from: number, to: number) => void;
    onhovermark?: (id: string | null) => void;
  } = {},
) {
  const bytes = buildPdf(opts.lines ?? ["Hello coding world.", "Zweite Zeile."]);
  const doc = await extractPdfDoc(bytes);
  render(PdfView, {
    bytes: bytes.slice(),
    text: doc.text,
    marks,
    armed: opts.armed ?? false,
    smart: opts.smart ?? true,
    preview: null,
    onadd: opts.onadd ?? (() => {}),
    onselect: opts.onselect ?? (() => {}),
    onpreview: () => {},
    onhovermark: opts.onhovermark ?? (() => {}),
  });
  await expect.element(page.getByRole("textbox")).toBeInTheDocument();
  return doc;
}

/** wait until the text layer has been stretched+measured (the span's transparent
    text occupies exactly its PDF box width) — drag tests need this for stable
    caret→offset mapping */
async function settled(span: HTMLElement): Promise<void> {
  const tn = span.firstChild as Text;
  const target = parseFloat(span.style.width);
  const r = document.createRange();
  await expect
    .poll(() => {
      r.selectNodeContents(tn);
      return Math.abs(r.getBoundingClientRect().width - target);
    })
    .toBeLessThan(1);
}

describe("PdfView", () => {
  it("renders pages, a text layer and mark rectangles", async () => {
    await mount([mk("e1", 0, 19, "1.1")]);
    expect(document.querySelectorAll(".pdfspan").length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
    await expect.poll(() => document.querySelectorAll(".pdfchip").length).toBeGreaterThan(0);
  });

  it("anchors the label chip row at its mark rectangle, not at the page corner", async () => {
    await mount([mk("e1", 0, 19, "1.1")]);
    await expect
      .poll(() => {
        const chip = document.querySelector(".pdfchip");
        const mark = document.querySelector(".pdfmark");
        if (!chip || !mark) return false;
        const c = chip.getBoundingClientRect();
        const m = mark.getBoundingClientRect();
        // chip row sits just above the mark's top edge, left-aligned with it
        return Math.abs(c.left - m.left) < 4 && Math.abs(c.bottom - m.top) < 4;
      })
      .toBe(true);
  });

  it("codes word-level coverage inside a line", async () => {
    // e1 covers the whole line, e2 only "coding" (offsets 6..12) → the line is
    // split at the mark boundaries into three rects, none covering the full span
    await mount([mk("e1", 0, 19, "1.1"), mk("e2", 6, 12, "2")]);
    await expect
      .poll(() => {
        const span = document.querySelector('.pdfspan[data-start="0"]');
        if (!span) return false;
        const sw = span.getBoundingClientRect().width;
        const rects = [...document.querySelectorAll(".pdfmark")].map((el) => {
          const r = el.getBoundingClientRect();
          return { w: r.width / sw, left: (r.left - span.getBoundingClientRect().left) / sw };
        });
        return rects.length === 3 && rects.every((r) => r.w < 0.9) && rects.some((r) => r.left > 0.2 && r.left < 0.45);
      })
      .toBe(true);
  });

  it("aligns mark rects with the stretched text layer (measured glyph positions)", async () => {
    await mount([mk("e1", 6, 12, "1.1")]); // "coding" inside "Hello coding world."
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const tn = span.firstChild as Text;
    const r = document.createRange();
    await expect
      .poll(() => {
        const mark = document.querySelector(".pdfmark");
        if (!mark) return false;
        r.setStart(tn, 6);
        r.setEnd(tn, 12);
        const tr = r.getBoundingClientRect();
        const mr = mark.getBoundingClientRect();
        return (
          Math.abs(mr.left - tr.left) < 2 &&
          Math.abs(mr.right - tr.right) < 2 &&
          Math.abs(mr.top - tr.top) < 3 &&
          Math.abs(mr.bottom - tr.bottom) < 3
        );
      })
      .toBe(true);
  });

  it("delegates drag selection to the canonical text (word-snapped, editor parity)", async () => {
    const sels: { from: number; to: number }[] = [];
    const adds: [number, number][] = [];
    await mount([mk("e1", 0, 19, "1.1")], {
      armed: true,
      onselect: (r) => {
        if (r !== null) sels.push(r);
      },
      onadd: (f, t) => adds.push([f, t]),
    });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const w = parseFloat(span.style.width); // stretched text occupies exactly this
    const y = sp.top + sp.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    // drag from inside "Hello" to mid-line: ends snap to whole words
    fire("mousedown", sp.left + 2, 1);
    fire("mousemove", sp.left + w * 0.6, 1);
    fire("mouseup", sp.left + w * 0.6, 0);
    expect(adds).toEqual([[0, 12]]); // "Hello coding" — snapped, not raw pixel offsets
    expect(sels.length).toBeGreaterThan(0);
    expect(sels[sels.length - 1]).toEqual({ from: 0, to: 12 }); // selection persists after coding
  });

  it("non-smart drag selects raw character offsets (plain CodeMirror parity)", async () => {
    const adds: [number, number][] = [];
    await mount([mk("e1", 0, 19, "1.1")], { armed: true, smart: false, onadd: (f, t) => adds.push([f, t]) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const w = parseFloat(span.style.width);
    const y = sp.top + sp.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    // mid-word start and end: must NOT expand to word boundaries
    fire("mousedown", sp.left + w * 0.25, 1);
    fire("mousemove", sp.left + w * 0.55, 1);
    fire("mouseup", sp.left + w * 0.55, 0);
    expect(adds.length).toBe(1);
    const [from, to] = adds[0];
    // the essential property: NOT expanded to word boundaries (snapWords would
    // give exactly [0, 12] = "Hello coding")
    expect(from).toBeGreaterThanOrEqual(1);
    expect(from).toBeLessThanOrEqual(5);
    expect(to).toBeGreaterThanOrEqual(8);
    expect(to).toBeLessThanOrEqual(11);
  });

  it("codes the same span for a backward (right→left) drag", async () => {
    const adds: [number, number][] = [];
    await mount([], { armed: true, onadd: (f, t) => adds.push([f, t]) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const w = parseFloat(span.style.width);
    const y = sp.top + sp.height / 2;
    // start mid-"coding", drag leftwards to the line start
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    fire("mousedown", sp.left + w * 0.6, 1);
    fire("mousemove", sp.left + 2, 1);
    fire("mouseup", sp.left + 2, 0);
    expect(adds).toEqual([[0, 12]]); // identical to the forward drag
  });

  it("drag across a line break selects across the newline", async () => {
    const adds: [number, number][] = [];
    await mount([], { armed: true, onadd: (f, t) => adds.push([f, t]) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const s1 = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    const s2 = document.querySelector('.pdfspan[data-start="20"]') as HTMLElement;
    await settled(s1);
    await settled(s2);
    const r1 = s1.getBoundingClientRect();
    const r2 = s2.getBoundingClientRect();
    const down = new MouseEvent("mousedown", {
      clientX: r1.left + 2,
      clientY: r1.top + r1.height / 2,
      buttons: 1,
      bubbles: true,
    });
    const move = new MouseEvent("mousemove", {
      clientX: r2.left + r2.width * 0.4,
      clientY: r2.top + r2.height / 2,
      buttons: 1,
      bubbles: true,
    });
    const up = new MouseEvent("mouseup", {
      clientX: r2.left + r2.width * 0.4,
      clientY: r2.top + r2.height / 2,
      buttons: 0,
      bubbles: true,
    });
    textEl.dispatchEvent(down);
    textEl.dispatchEvent(move);
    textEl.dispatchEvent(up);
    expect(adds.length).toBe(1);
    expect(adds[0][0]).toBe(0);
    expect(adds[0][1]).toBeGreaterThanOrEqual(20); // crosses the \n between the lines
  });

  it("dragging back onto the anchor collapses the selection (caret parity)", async () => {
    const sels: ({ from: number; to: number } | null)[] = [];
    await mount([], { onselect: (r) => sels.push(r) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const w = parseFloat(span.style.width);
    const y = sp.top + sp.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    fire("mousedown", sp.left + 2, 1);
    fire("mousemove", sp.left + w * 0.6, 1);
    expect(sels.length).toBeGreaterThan(0);
    fire("mousemove", sp.left + 2, 1); // back onto the anchor → collapse
    expect(sels[sels.length - 1]).toBe(null);
  });

  it("clicking the page margin codes nothing", async () => {
    const adds: [number, number][] = [];
    await mount([], { armed: true, onadd: (f, t) => adds.push([f, t]) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const pageEl = document.querySelector(".pdfpage") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const pr = pageEl.getBoundingClientRect();
    const y = span.getBoundingClientRect().top + 4;
    const x = pr.left + 4; // left of the text block: PDF margin
    textEl.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, buttons: 1, bubbles: true }));
    textEl.dispatchEvent(new MouseEvent("mouseup", { clientX: x, clientY: y, buttons: 0, bubbles: true }));
    expect(adds).toEqual([]);
  });

  it("unarmed drag selects but never codes", async () => {
    const adds: [number, number][] = [];
    const sels: { from: number; to: number }[] = [];
    await mount([], {
      armed: false,
      onadd: (f, t) => adds.push([f, t]),
      onselect: (r) => {
        if (r !== null) sels.push(r);
      },
    });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const w = parseFloat(span.style.width);
    const y = sp.top + sp.height / 2;
    const fire = (type: string, x: number, buttons: number) =>
      textEl.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true }));
    fire("mousedown", sp.left + 2, 1);
    fire("mousemove", sp.left + w * 0.6, 1);
    fire("mouseup", sp.left + w * 0.6, 0);
    expect(adds).toEqual([]);
    expect(sels.length).toBeGreaterThan(0);
    expect(sels[sels.length - 1]).toEqual({ from: 0, to: 12 });
  });

  it("a drag released outside the text layer never codes", async () => {
    const adds: [number, number][] = [];
    await mount([], { armed: true, onadd: (f, t) => adds.push([f, t]) });
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const span = document.querySelector('.pdfspan[data-start="0"]') as HTMLElement;
    await settled(span);
    const sp = span.getBoundingClientRect();
    const y = sp.top + sp.height / 2;
    textEl.dispatchEvent(new MouseEvent("mousedown", { clientX: sp.left + 2, clientY: y, buttons: 1, bubbles: true }));
    textEl.dispatchEvent(
      new MouseEvent("mousemove", { clientX: sp.left + sp.width * 0.6, clientY: y, buttons: 1, bubbles: true }),
    );
    // no mouseup on the text layer: coding only happens on release there
    expect(adds).toEqual([]);
  });

  it("degenerate and out-of-range marks render no rects and crash nothing", async () => {
    await mount([mk("d1", 5, 5, "x"), mk("d2", -10, -1, "y"), mk("d3", 1000, 2000, "z")]);
    await expect.poll(() => document.querySelectorAll(".pdfpage").length).toBe(1);
    expect(document.querySelectorAll(".pdfmark").length).toBe(0);
    expect(document.querySelectorAll(".pdfchip").length).toBe(0);
  });

  it("fuzz: random overlapping marks stay inside their page", async () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const marks = Array.from({ length: 40 }, (_, i) => {
      const a = Math.floor(rnd() * 34);
      const b = Math.floor(rnd() * 34);
      return mk(`f${i}`, Math.min(a, b), Math.max(a, b) + 1, `f${i}`, `hsl(${Math.floor(rnd() * 360)} 70% 45%)`);
    });
    await mount(marks);
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBeGreaterThan(0);
    const pr = document.querySelector(".pdfpage")!.getBoundingClientRect();
    for (const el of document.querySelectorAll(".pdfmark")) {
      const r = el.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      expect(r.left).toBeGreaterThanOrEqual(pr.left - 1);
      expect(r.right).toBeLessThanOrEqual(pr.right + 1);
      expect(r.top).toBeGreaterThanOrEqual(pr.top - 1);
      expect(r.bottom).toBeLessThanOrEqual(pr.bottom + 1);
    }
  });

  it("overlapping marks hatch both device colors in the shared segment", async () => {
    await mount([mk("e1", 0, 19, "1.1", "#ff0000"), mk("e2", 6, 12, "2.2", "#00ff00")]);
    await expect.poll(() => document.querySelectorAll(".pdfmark").length).toBe(3);
    const both = [...document.querySelectorAll(".pdfmark")].some((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      // the stops are color-mix() expressions, so Chromium serializes them as
      // color(srgb r g b / a) — 1 0 0 / 0 1 0 are the two fixture colors
      return bg.includes("1 0 0") && bg.includes("0 1 0");
    });
    expect(both).toBe(true);
  });

  it("chip hover drives onhovermark in and out", async () => {
    const hovered: (string | null)[] = [];
    await mount([mk("e1", 0, 19, "1.1")], { onhovermark: (id) => hovered.push(id) });
    await expect.poll(() => document.querySelector(".pdfchip") !== null).toBe(true);
    const chip = document.querySelector(".pdfchip") as HTMLElement;
    chip.dispatchEvent(new MouseEvent("mouseenter"));
    chip.dispatchEvent(new MouseEvent("mouseleave"));
    expect(hovered).toEqual(["e1", null]);
  });

  it("an empty PDF renders a page but stays inert", async () => {
    const adds: [number, number][] = [];
    await mount([], { armed: true, lines: [""], onadd: (f, t) => adds.push([f, t]) });
    await expect.poll(() => document.querySelectorAll(".pdfpage").length).toBe(1);
    const textEl = document.querySelector(".pdftext") as HTMLElement;
    const pr = document.querySelector(".pdfpage")!.getBoundingClientRect();
    const x = pr.left + pr.width / 2;
    const y = pr.top + pr.height / 2;
    textEl.dispatchEvent(new MouseEvent("mousedown", { clientX: x, clientY: y, buttons: 1, bubbles: true }));
    textEl.dispatchEvent(new MouseEvent("mousemove", { clientX: x + 40, clientY: y, buttons: 1, bubbles: true }));
    textEl.dispatchEvent(new MouseEvent("mouseup", { clientX: x + 40, clientY: y, buttons: 0, bubbles: true }));
    expect(adds).toEqual([]);
  });

  it("shows the crosshair cursor on the text surface when smart select is on", async () => {
    await mount([], { smart: true });
    const surface = document.querySelector(".pdftext") as HTMLElement;
    expect(surface.classList.contains("smartsel")).toBe(true);
    expect(getComputedStyle(surface).cursor).toBe("crosshair");
  });

  it("keeps the plain text cursor when smart select is off", async () => {
    await mount([], { smart: false, armed: false });
    const surface = document.querySelector(".pdftext") as HTMLElement;
    expect(surface.classList.contains("smartsel")).toBe(false);
    expect(getComputedStyle(surface).cursor).toBe("text");
  });
});
