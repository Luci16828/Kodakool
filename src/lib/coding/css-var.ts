/**
 * CSS helpers for the hover fade of coded marks.
 *
 * The coding page fades every mark that is NOT under the hovered catalog device.
 * Doing that in JavaScript rebuilds every CodeMirror decoration on every mouse
 * move; instead every coverage stop is painted with a per-device alpha variable
 * (`--a-<device>`), and the page only flips one `data-hover-device` attribute on
 * the surface. The generated rules below do the rest, and the registered
 * variables make the color change animate.
 */

/** a CSS custom-property name for an entry/catalog key (UUIDs and numeric codes) */
export function cssVar(id: string): string {
  return `--a-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** the alpha variable of a coverage stop (100% = fully visible) */
export function alphaVar(id: string | null | undefined): string {
  return id ? `var(${cssVar(id)}, 100%)` : "100%";
}

/** the minimal catalog shape the fade rules need (CatalogView is compatible) */
export interface HoverFadeNode {
  id: string;
  children: HoverFadeNode[];
}

/**
 * The hover-fade stylesheet for the current set of device keys.
 *
 * `ids` are the catalog ids + entry keys the marks can carry. The generic rule
 * dims every alpha variable while a device is hovered; the per-node rules lift
 * the hovered node **and its whole subtree** back to full color. Selection/preview
 * fade stays in JavaScript (the surface carries `data-fade` then, which switches
 * these rules off).
 */
export function hoverFadeCss(ids: string[], tree: HoverFadeNode[]): string {
  if (ids.length === 0) return "";
  const vars = ids.map(cssVar);
  const varOf = new Map(ids.map((id, i) => [id, vars[i]]));

  const props = vars.map((v) => `@property ${v} { syntax: "<percentage>"; inherits: true; initial-value: 100%; }`);

  const surfaces = [".editorrow", ".pdfview"];
  const dimBars = surfaces
    .map(
      (s) =>
        `${s}[data-hover-device]:not([data-fade]) .cm-underline, ${s}[data-hover-device]:not([data-fade]) .mstripe, ${s}[data-hover-device]:not([data-fade]) .pdfmark`,
    )
    .join(", ");
  const dimChips = surfaces
    .map(
      (s) =>
        `${s}[data-hover-device]:not([data-fade]) .cm-tag:not(.cm-tag-hot), ${s}[data-hover-device]:not([data-fade]) .pdfchip:not(.hot)`,
    )
    .join(", ");

  const dimBarDecl = vars.map((v) => `${v}: 32%;`).join(" ");
  const barTargets = [".cm-underline", ".mstripe", ".pdfmark"];

  const subtree = (n: HoverFadeNode, acc: string[] = []): string[] => {
    acc.push(n.id);
    for (const c of n.children) subtree(c, acc);
    return acc;
  };
  const allNodes = (ns: HoverFadeNode[], acc: HoverFadeNode[] = []): HoverFadeNode[] => {
    for (const n of ns) {
      acc.push(n);
      allNodes(n.children, acc);
    }
    return acc;
  };

  const litBars = allNodes(tree)
    .map((n) => {
      const lit = subtree(n)
        .map((id) => varOf.get(id))
        .filter((v): v is string => v !== undefined);
      if (lit.length === 0) return "";
      const sels: string[] = [];
      for (const s of surfaces) {
        for (const t of barTargets) sels.push(`${s}[data-hover-device="${n.id}"]:not([data-fade]) ${t}`);
      }
      return `${sels.join(", ")} { ${lit.map((v) => `${v}: 100%;`).join(" ")} }`;
    })
    .filter(Boolean)
    .join("\n");

  const litChips = allNodes(tree)
    .map((n) => {
      const lit = subtree(n).filter((id) => varOf.has(id));
      if (lit.length === 0) return "";
      const sels: string[] = [];
      for (const s of surfaces) {
        for (const id of lit) {
          sels.push(`${s}[data-hover-device="${n.id}"]:not([data-fade]) .cm-tag[data-device="${id}"]`);
          sels.push(`${s}[data-hover-device="${n.id}"]:not([data-fade]) .pdfchip[data-device="${id}"]`);
        }
      }
      return `${sels.join(", ")} { opacity: 1; }`;
    })
    .filter(Boolean)
    .join("\n");

  const barTransition = `.cm-underline, .mstripe, .pdfmark { transition: ${vars.map((v) => `${v} 180ms ease`).join(", ")}; }`;
  const chipTransition =
    ".cm-tag, .pdfchip { transition: opacity 180ms ease, background-color 180ms ease, color 180ms ease; }";

  return [
    props.join("\n"),
    `${dimBars} { ${dimBarDecl} }`,
    `${dimChips} { opacity: 0.32; }`,
    litBars,
    litChips,
    barTransition,
    chipTransition,
  ].join("\n");
}
