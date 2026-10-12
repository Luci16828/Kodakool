// Static export (adapter-static + GitHub Pages): prerender every page that can be prerendered.
// `/` is a real static page; the coding page is `ssr = false` (its data is RxDB in the browser),
// so its deep links are served by the `404.html` fallback shell.
export const prerender = true;
