/**
 * Browser download helpers shared by every export in the app
 * (database snapshot, .qdc / JSON catalogs, document downloads).
 */

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
