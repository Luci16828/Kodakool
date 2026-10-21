import type { PageLoad } from "./$types";

export const ssr = false;
// remote (server + Yjs) driven, never prerenderable
export const prerender = false;

export const load: PageLoad = ({ params }) => ({
  account: params.account,
  folder: params.folder,
  name: params.name,
});
