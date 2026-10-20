/**
 * The app has a single screen (the coding page), so the root URL needs to know
 * which document to open: the coding page records the document it loads here,
 * and the root page opens it again on the next visit.
 */
const KEY = "luci-last-doc";

export function rememberDoc(folder: string, name: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ folder, name }));
  } catch {
    // storage disabled (private mode) — the root page falls back to the first document
  }
}

export function lastDoc(): { folder: string; name: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { folder?: unknown; name?: unknown } | null;
    return v && typeof v.folder === "string" && typeof v.name === "string" ? { folder: v.folder, name: v.name } : null;
  } catch {
    return null;
  }
}
