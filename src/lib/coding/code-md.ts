import { EditorState, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

/**
 * Markdown documents: `markdown()` parses the document, `mdHighlight` maps its
 * tokens to `cm-*` classes (styled theme-aware in CodingDoc), and
 * `frontmatterField` adds YAML token colors to a leading `---` frontmatter
 * block, which lang-markdown does not parse.
 */
export function mdExtensions() {
  return [markdown(), frontmatterField, syntaxHighlighting(mdHighlight)];
}

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "cm-header cm-header-1" },
  { tag: t.heading2, class: "cm-header cm-header-2" },
  { tag: t.heading3, class: "cm-header cm-header-3" },
  { tag: t.heading4, class: "cm-header cm-header-4" },
  { tag: t.heading5, class: "cm-header cm-header-5" },
  { tag: t.heading6, class: "cm-header cm-header-6" },
  { tag: t.strong, class: "cm-strong" },
  { tag: t.emphasis, class: "cm-em" },
  { tag: t.link, class: "cm-link" },
  { tag: t.url, class: "cm-url" },
  { tag: t.monospace, class: "cm-code" },
  { tag: t.quote, class: "cm-quote" },
  { tag: t.list, class: "cm-list" },
  { tag: t.contentSeparator, class: "cm-hr" },
  { tag: t.processingInstruction, class: "cm-processing" },
]);

const KEY_RE = /^(\s*)([A-Za-z0-9_.-]+)(:)(.*)$/;

function frontmatterSpan(state: EditorState): { from: number; to: number; first: number; last: number } | null {
  const doc = state.doc;
  if (doc.lines < 3 || doc.line(1).text.trim() !== "---") return null;
  for (let l = 2; l <= doc.lines; l++) {
    if (doc.line(l).text.trim() === "---") return { from: doc.line(1).from, to: doc.line(l).to, first: 1, last: l };
  }
  return null;
}

function frontmatterDecorations(state: EditorState): DecorationSet {
  const span = frontmatterSpan(state);
  if (!span) return Decoration.none;
  const out: Range<Decoration>[] = [Decoration.mark({ class: "cm-frontmatter" }).range(span.from, span.to)];
  const push = (from: number, to: number, cls: string): void => {
    if (from < to) out.push(Decoration.mark({ class: cls }).range(from, to));
  };
  for (let l = span.first + 1; l < span.last; l++) {
    const line = state.doc.line(l);
    const m = KEY_RE.exec(line.text);
    if (!m) continue;
    const keyFrom = line.from + m[1].length;
    push(keyFrom, keyFrom + m[2].length, "cm-property");
    const val = m[4];
    const valFrom = keyFrom + m[2].length + m[3].length;
    const lead = val.length - val.trimStart().length;
    const value = val.trim();
    if (/^(["']).*\1$/.test(value)) push(valFrom + lead, valFrom + lead + value.length, "cm-string");
    else if (/^-?\d+(\.\d+)?$/.test(value)) push(valFrom + lead, valFrom + lead + value.length, "cm-number");
    else if (/^(true|false|null)$/.test(value)) push(valFrom + lead, valFrom + lead + value.length, "cm-bool");
  }
  out.sort((a, b) => a.from - b.from || b.to - a.to);
  return Decoration.set(out, true);
}

const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state),
  update(value, tr) {
    return tr.docChanged ? frontmatterDecorations(tr.state) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
