import type { Instructions } from "$lib/coding/instructions";

export const ssr = false;

export async function load({
  fetch,
}: {
  fetch: typeof globalThis.fetch;
}): Promise<{ catalogs: { folder: string; instructions: Instructions }[] }> {
  try {
    const res = await fetch("/api/catalog");
    if (!res.ok) return { catalogs: [] };
    return { catalogs: await res.json() };
  } catch {
    return { catalogs: [] };
  }
}
