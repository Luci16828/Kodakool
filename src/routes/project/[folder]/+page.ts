import type { PageLoad } from "./$types";

export const ssr = false;
// RxDB-driven, so it can never be prerendered: deep links are served by the
// adapter-static fallback page (404.html on GitHub Pages).
export const prerender = false;

export const load: PageLoad = ({ params }) => ({ folder: params.folder });
