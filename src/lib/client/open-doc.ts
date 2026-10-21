import { goto } from "$app/navigation";
import { resolve } from "$app/paths";
import { createArticle, createFolder } from "$lib/local/local-api";

/**
 * Document navigation shared by every surface that opens the coding page
 * (root start screen, tree sidebar, project switcher).
 */

/** Navigate to a document's coding page. */
export function openDoc(project: string, name: string): Promise<void> {
  return goto(resolve("/text/[folder]/[name]", { folder: project, name }));
}

/** Create a fresh document in the project (optionally in a subfolder) and open its coding page. */
export async function openNewDoc(project: string, folder = ""): Promise<void> {
  const a = await createArticle(project, "text", folder);
  // navigate by the project NAME (the summary carries the project id)
  await openDoc(project, a.name);
}

/** Create a project (createFolder is idempotent: a taken name just opens a fresh document in it) and open the new document. */
export async function createProjectDoc(name: string): Promise<void> {
  await createFolder(name);
  await openNewDoc(name);
}

/** Navigate to a document of a remote account (its coding page is the 3-segment route). */
export function openRemoteDoc(account: string, project: string, name: string): Promise<void> {
  return goto(resolve("/text/[account]/[folder]/[name]", { account, folder: project, name }));
}
