import type { ArticleKind, ArticleSummary } from "$lib/client/coding-db";

/**
 * Document display helpers shared by every surface that lists articles
 * (project screen card, project page list, coding-page tree).
 */

/** file-tree icon per article: PDFs get the news-page glyph, markdown and
    plain text their own document glyphs (names keep the .md/.markdown suffix) */
export function docIcon(a: ArticleSummary): string {
  if (a.kind === "pdf") return "newsmode";
  return /\.(md|markdown)$/i.test(a.name) ? "markdown_document" : "article";
}

/** name with the file ending for its kind — uploads strip `.txt`/`.pdf` from
    the stored name, the UI shows them again (markdown already carries its own) */
export function displayName(name: string, kind: ArticleKind): string {
  if (kind === "pdf") return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  if (/\.(md|markdown)$/i.test(name)) return name;
  return /\.txt$/i.test(name) ? name : `${name}.txt`;
}

/** document order used across the app: by project, then numeric-aware name
    ("doc 2" before "doc 10") — tree, switcher, dashboard and db listings share it */
export function compareDocs(a: { project: string; name: string }, b: { project: string; name: string }): number {
  return a.project.localeCompare(b.project) || compareNames(a.name, b.name);
}

/** locale-aware, numeric-aware name/project order */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
