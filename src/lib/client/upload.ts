import { createArticle, deleteArticle, getArticle, renameArticle, saveArticle, savePdfData } from "./coding-db";

/**
 * File → article uploads, shared by the project page and the coding page
 * (both target one specific project).
 */

export interface UploadResult {
  /** false when the file was skipped (duplicate name, unreadable PDF) */
  ok: boolean;
  /** message to show the user ("" = nothing to report) */
  message: string;
}

/**
 * Turn one picked/dropped `.txt`/`.md`/`.pdf` file into an article inside `project`.
 * A picked folder's `webkitRelativePath` is deliberately ignored: uploads always
 * target the project the UI states. `.pdf` is extracted in the browser (unpdf stays
 * out of the main bundle) and its original bytes are stored for the PDF view.
 * `.md`/`.markdown` keeps its extension (it drives highlighting + download).
 */
export async function uploadArticleFile(
  project: string,
  f: File,
  onProgress?: (msg: string) => void,
  folder = "",
): Promise<UploadResult> {
  const segs = (f.webkitRelativePath || f.name).split("/");
  const isPdfFile = /\.pdf$/i.test(f.name);
  const name = segs[segs.length - 1].replace(/\.(txt|pdf)$/i, "").trim();
  if (!name) return { ok: false, message: "" };
  if (await getArticle(project, name)) return { ok: false, message: `"${name}" already exists` };

  let text: string;
  let pdfBytes: Uint8Array | null = null;
  let pdfPages = 0;
  if (isPdfFile) {
    // client-side extraction (unpdf in the browser): the PDF never touches the server
    onProgress?.(`extracting ${name}…`);
    try {
      const { extractPdfDoc } = await import("$lib/coding/pdf");
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      const doc = await extractPdfDoc(pdfBytes);
      text = doc.text;
      pdfPages = doc.pages;
    } catch (e) {
      return { ok: false, message: `pdf: ${String(e)}` };
    }
  } else {
    text = await f.text();
  }

  const created = await createArticle(project, isPdfFile ? "pdf" : "text", folder);
  try {
    await saveArticle(created.id, text, []);
    if (pdfBytes !== null) await savePdfData(created.id, pdfBytes, pdfPages);
    await renameArticle(created.id, name);
  } catch {
    // a concurrent upload won the name (renameArticle keeps (project, name) unique):
    // remove the scratch article so the store stays clean
    await deleteArticle(created.id);
    return { ok: false, message: `"${name}" already exists` };
  }
  return { ok: true, message: `uploaded ${name}` };
}

/** Folder picker: every `.txt`/`.md`/`.pdf` file inside becomes an article in `project` (in `folder`). */
export async function uploadArticleFolder(project: string, input: HTMLInputElement, folder = ""): Promise<string[]> {
  const files = [...(input.files ?? [])].filter((f) => /\.(txt|md|markdown|pdf)$/i.test(f.name));
  input.value = "";
  const messages: string[] = [];
  for (const f of files) {
    const r = await uploadArticleFile(project, f, undefined, folder);
    if (r.message !== "") messages.push(r.message);
  }
  return messages;
}
