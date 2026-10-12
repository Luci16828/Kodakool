import { createArticle, createFolder, getArticle, renameArticle, saveArticle, saveLocalCatalog } from "./coding-db";
import { codingFileSchema } from "$lib/coding/types";
import { instructionsSchema } from "$lib/coding/instructions";
import exampleCodingRaw from "$lib/assets/examples/example-coding.json";
import exampleCatalogRaw from "$lib/assets/examples/frame-devices.json";
import exampleText from "$lib/assets/examples/Junge Freiheit 22.txt?raw";

/**
 * The bundled example project (`src/lib/assets/examples/`): a real newspaper
 * article, 132 verified coding entries and its full frame-device catalog.
 * Seeded once into the local RxDB store so a fresh visit shows a working project.
 */

export const EXAMPLE_PROJECT = "example";
export const EXAMPLE_DOC = "Junge Freiheit 22";

const SEED_FLAG = "luci-example-seeded";

/**
 * Seed the example project (folder + article + entries + catalog) into RxDB.
 * Runs at most once per browser profile: a localStorage flag makes the seed
 * idempotent, and a user who deletes the example project never gets it back.
 */
export async function seedExampleProject(): Promise<boolean> {
  if (localStorage.getItem(SEED_FLAG) !== null) return false;
  const coding = codingFileSchema.parse(exampleCodingRaw);
  const catalog = instructionsSchema.parse(exampleCatalogRaw);
  if (!(await getArticle(EXAMPLE_PROJECT, EXAMPLE_DOC))) {
    await createFolder(EXAMPLE_PROJECT);
    const article = await createArticle(EXAMPLE_PROJECT);
    await saveArticle(article.id, exampleText, coding.codes);
    await renameArticle(article.id, EXAMPLE_DOC);
  }
  await saveLocalCatalog(EXAMPLE_PROJECT, catalog);
  localStorage.setItem(SEED_FLAG, "1");
  return true;
}
