import type { PageLoad } from "./$types";

export const ssr = false;
// the IdP lands here with ?code&state; everything is client-side
export const prerender = false;

export const load: PageLoad = ({ url }) => ({
  code: url.searchParams.get("code"),
  state: url.searchParams.get("state"),
  error: url.searchParams.get("error"),
});
