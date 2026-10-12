import { error, json } from "@sveltejs/kit";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "prettier";
import { CODING_ROOT, SOURCES_ROOT, listSources, loadSourceText, type SourceRef } from "$lib/server/coding/store";
import { codingFileSchema } from "$lib/coding/types";
import type { CodingFile } from "$lib/coding/types";
import { parseCodingJson, verifyCoding } from "$lib/coding/verify";
import type { RequestHandler } from "./$types";

function refFor(params: { folder: string; name: string }): SourceRef {
  const ref = listSources().find((s) => s.folder === params.folder && s.name === params.name);
  if (!ref) error(404, `unknown source "${params.folder}/${params.name}"`);
  return ref;
}

function codingFilePath(ref: SourceRef): string {
  return path.join(CODING_ROOT, ref.folder, `${ref.name}.json`);
}

export const GET: RequestHandler = async ({ params }) => {
  const ref = refFor(params);
  const file = codingFilePath(ref);
  if (!existsSync(file)) return json({ source: ref.source, codes: [], errors: [] });
  let parsed: CodingFile;
  try {
    parsed = parseCodingJson(readFileSync(file, "utf8"));
  } catch (e) {
    error(422, `invalid coding json: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({
    source: parsed.source,
    codes: parsed.codes,
    errors: verifyCoding(await loadSourceText(ref), parsed).map((e) => e.message),
  });
};

export const PUT: RequestHandler = async ({ params, request }) => {
  const ref = refFor(params);
  const body = (await request.json().catch(() => undefined)) as unknown;
  const parsed = codingFileSchema.safeParse(body);
  if (!parsed.success) {
    error(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  if (parsed.data.source !== ref.source) {
    error(400, `source mismatch: expected "${ref.source}"`);
  }
  const text = await loadSourceText(ref);
  const errors = verifyCoding(text, parsed.data);
  if (errors.length > 0) return json({ ok: false, errors: errors.map((e) => e.message) }, { status: 422 });
  const file = codingFilePath(ref);
  const raw = JSON.stringify(parsed.data, null, "\t") + "\n";
  writeFileSync(file, await format(raw, { filepath: file }), "utf8");
  return json({ ok: true, errors: [] });
};
