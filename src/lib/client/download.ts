/**
 * Browser download helpers shared by every export in the app
 * (database snapshot, .qdc / JSON catalogs, document downloads).
 */
import { displayName } from "$lib/coding/display";
import { base64ToBytes, getArticleById, getPdfData, type ArticleSummary } from "./coding-db";

/** Trigger a browser download for a Blob (object URL + click + revoke). */
export function downloadBlob(filename: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Text-flavored shorthand (JSON / XML / markdown / plain text exports). */
export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/**
 * Download one stored document: PDFs their original bytes, texts their stored
 * body as `.md`/`.txt` (the same rules as the bar's download picker).
 */
export async function downloadArticle(a: ArticleSummary): Promise<void> {
  if (a.kind === "pdf") {
    const pdf = await getPdfData(a.id);
    if (pdf === null) return;
    // .slice() gives a fresh ArrayBuffer-backed view (BlobPart requires it)
    downloadBlob(displayName(a.name, "pdf"), new Blob([base64ToBytes(pdf.data).slice()], { type: "application/pdf" }));
    return;
  }
  const text = (await getArticleById(a.id))?.text ?? "";
  if (text === "") return;
  const filename = displayName(a.name, a.kind);
  downloadText(filename, text, /\.(md|markdown)$/i.test(filename) ? "text/markdown" : "text/plain");
}
