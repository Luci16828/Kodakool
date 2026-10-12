import { error, json } from "@sveltejs/kit";
import { loadInstructions } from "$lib/server/coding/store";
import type { RequestHandler } from "./$types";

/** Read-only raw frame-device catalog for a folder (null when absent/invalid). */
export const GET: RequestHandler = ({ params }) => {
  const folder = params.folder;
  if (folder === "" || folder.includes("/") || folder.includes("..")) error(400, "invalid folder");
  return json(loadInstructions(folder));
};
