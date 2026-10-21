import { createArticleNamed, deleteArticle, listArticles, savePdfData } from "$lib/local/local-api";

/**
 * File → document uploads (the Local account's in-worker server owns the store).
 */

export interface UploadResult {
  /** false when the file was skipped (duplicate name, unreadable PDF) */
  ok: boolean;
  /** message to show the user ("" = nothing to report) */
  message: string;
}

/**
 * Turn one picked/dropped `.txt`/`.md`/`.pdf` file into a document inside `project`.
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
  const keep = /\.(md|markdown)$/i.test(f.name);
  const name = (keep ? segs[segs.length - 1] : segs[segs.length - 1].replace(/\.(txt|pdf)$/i, "")).trim();
  if (!name) return { ok: false, message: "" };
  if ((await listArticles(project)).some((d) => d.name === name))
    return { ok: false, message: `"${name}" already exists` };

  let text: string;
  let pdfBytes: Uint8Array | null = null;
  if (isPdfFile) {
    // client-side extraction (unpdf in the browser): the PDF bytes then ride to the store
    onProgress?.(`extracting ${name}…`);
    try {
      const { extractPdfDoc } = await import("$lib/coding/pdf");
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      const doc = await extractPdfDoc(pdfBytes.slice());
      text = doc.text;
    } catch (e) {
      return { ok: false, message: `pdf: ${String(e)}` };
    }
  } else {
    text = await f.text();
  }

  try {
    const created = await createArticleNamed(project, name, text, folder, isPdfFile ? "pdf" : "text");
    if (pdfBytes !== null) await savePdfData(created.id, pdfBytes);
  } catch {
    // a concurrent upload won the name ((project, name) is unique server-side)
    return { ok: false, message: `"${name}" already exists` };
  }
  return { ok: true, message: `uploaded ${name}` };
}

/** Folder picker: every `.txt`/`.md`/`.pdf` file inside becomes a document in `project` (in `folder`). */
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
