import { createArticleNamed, getLocalCatalog, listArticles, saveLocalCatalog } from "$lib/local/local-api";
import { codingFileSchema } from "$lib/coding/types";
import { instructionsSchema } from "$lib/coding/instructions";
import exampleCodingRaw from "$lib/assets/examples/example-coding.json";
import exampleCatalogRaw from "$lib/assets/examples/frame-devices.json";
import exampleText from "$lib/assets/examples/Junge Freiheit 22.txt?raw";

/**
 * The bundled example project (`src/lib/assets/examples/`): a real newspaper
 * article, 132 verified coding entries and its full frame-device catalog.
 * Seeded once into the local store (the in-worker server) so a fresh visit
 * shows a working project.
 */

export const EXAMPLE_PROJECT = "example";
export const EXAMPLE_DOC = "Junge Freiheit 22";

const SEED_FLAG = "luci-example-seeded";

/**
 * Seed the example project (project + document + entries + catalog) into the
 * local worker store. Runs at most once per browser profile: a localStorage
 * flag makes the seed idempotent, and a user who deletes the example project
 * never gets it back.
 */
async function doSeed(): Promise<boolean> {
  if (localStorage.getItem(SEED_FLAG) !== null) return false;
  const coding = codingFileSchema.parse(exampleCodingRaw);
  const catalog = instructionsSchema.parse(exampleCatalogRaw);
  const docs = await listArticles(EXAMPLE_PROJECT);
  if (!docs.some((d) => d.name === EXAMPLE_DOC)) {
    const doc = await createArticleNamed(EXAMPLE_PROJECT, EXAMPLE_DOC, exampleText);
    const { setLocalCodes } = await import("$lib/local/local-api");
    await setLocalCodes(doc.id, coding.codes);
  }
  if ((await getLocalCatalog(EXAMPLE_PROJECT)) === null) await saveLocalCatalog(EXAMPLE_PROJECT, catalog);
  localStorage.setItem(SEED_FLAG, "1");
  return true;
}

/**
 * The seed is fire-and-forget in the layout, so a **cold deep link** to a coding
 * page can query RxDB before it finishes and briefly see no article at all.
 * Coalescing the in-flight run lets that page await the same seed instead of
 * guessing, which is what keeps the first visit to a shared link from landing on
 * the "does not exist" screen. Only the run in flight is shared — the result is
 * never cached, so the per-call "did I seed just now?" contract above holds and
 * a deleted example stays deleted.
 */
let inflight: Promise<boolean> | null = null;

export function seedExampleProject(): Promise<boolean> {
  if (inflight !== null) return inflight;
  const run = doSeed().finally(() => {
    if (inflight === run) inflight = null;
  });
  inflight = run;
  return run;
}

/**
 * Resolves once the layout's seed run has settled. A cold deep link awaits this
 * before declaring a document missing, because the layout seeds fire-and-forget
 * and the store can briefly look empty. With no seed in flight — specs mount the
 * page directly, with no layout — it resolves at once, so a genuinely absent
 * document is still reported immediately.
 */
export function seedSettled(): Promise<void> {
  return inflight === null ? Promise.resolve() : inflight.then(() => {});
}
