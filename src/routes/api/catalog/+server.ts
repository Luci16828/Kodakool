import { json } from "@sveltejs/kit";
import { listCatalogFolders, loadInstructions } from "$lib/server/coding/store";

export function GET() {
  const catalogs = listCatalogFolders().flatMap((folder) => {
    const instructions = loadInstructions(folder);
    return instructions ? [{ folder, instructions }] : [];
  });
  return json(catalogs);
}
