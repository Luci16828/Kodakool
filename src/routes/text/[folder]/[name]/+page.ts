import type { Instructions } from "$lib/coding/instructions";

export const ssr = false;

export async function load({
  fetch,
  params,
}: {
  fetch: typeof globalThis.fetch;
  params: { folder: string; name: string };
}): Promise<{ folder: string; name: string; instructions: Instructions | null }> {
  let instructions: Instructions | null = null;
  try {
    const res = await fetch(`/api/instructions/${encodeURIComponent(params.folder)}`);
    if (res.ok) instructions = (await res.json()) as Instructions | null;
  } catch {
    instructions = null;
  }
  return { folder: params.folder, name: params.name, instructions };
}
