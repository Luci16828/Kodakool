import { goto } from "$app/navigation";
import { resolve } from "$app/paths";
import { createArticle, createFolder } from "./coding-db";

/**
 * Document navigation shared by every surface that opens the coding page
 * (root start screen, tree sidebar, project switcher).
 */

/** Navigate to a document's coding page. */
export function openDoc(project: string, name: string): Promise<void> {
  return goto(resolve("/text/[folder]/[name]", { folder: project, name }));
}

/** Create a fresh document in the project and open its coding page. */
export async function openNewDoc(project: string): Promise<void> {
  const a = await createArticle(project);
  await openDoc(a.project, a.name);
}

/** Create a project (createFolder is idempotent: a taken name just opens a fresh document in it) and open the new document. */
export async function createProjectDoc(name: string): Promise<void> {
  await createFolder(name);
  await openNewDoc(name);
}
