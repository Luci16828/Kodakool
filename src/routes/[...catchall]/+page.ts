import { redirect } from "@sveltejs/kit";
import { resolve } from "$app/paths";

/**
 * The app has exactly two screens: the main page and the coding page. Every
 * unknown path — the removed /project/<folder> deep links included — lands
 * back on the main page (the SPA fallback boots the client router, which
 * resolves this catch-all and redirects). `resolve()` keeps the redirect
 * target base-aware for the GitHub Pages sub-path.
 */
export const ssr = false;
export const prerender = false;

export function load(): never {
  redirect(301, resolve("/"));
}
