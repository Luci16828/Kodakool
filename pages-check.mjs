// Local GitHub-Pages simulation: serves build/ under /Kodakool/ and answers every
// unknown path with 404.html + status 404, exactly like GitHub Pages does for a
// project site. Used to prove the static export + SPA fallback works.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = "build";
const BASE = "/Kodakool";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const send = (file, status) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(status, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
    return true;
  };
  if (!p.startsWith(BASE)) return void (res.writeHead(404), res.end("outside base"));
  const rel = p.slice(BASE.length) || "/";
  if (rel === "/") return void send(path.join(ROOT, "index.html"), 200);
  if (send(path.join(ROOT, rel), 200)) return;
  send(path.join(ROOT, "404.html"), 404); // GitHub Pages SPA fallback
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}${BASE}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()} @ ${m.location().url}`));

// 1. the root URL opens the app's single screen: with a fresh profile the example
//    seeds, and the root redirects into its coding page
const home = await page.goto(`${url}/`);
const homeEditor = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
console.log(
  "home status:",
  home.status(),
  "| opened the example document:",
  new URL(page.url()).pathname === `${BASE}/text/example/Junge%20Freiheit%2022`,
  "| editor mounted:",
  homeEditor,
);

// 2. deep link to a coding page: served by 404.html, client router takes over
const deep = await page.goto(`${url}/text/example/Junge%20Freiheit%2022`);
const editor = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
const doc = await page.textContent(".cm-content").catch(() => "");
// the catalog aside renders its device rows (the old `text=Devices` assertion was
// stale: the aside header is "New category"/"New code"/"Edit", so it silently
// reported false and the check still passed)
const catalog = await page
  .waitForSelector(".catalog .tnode", { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
console.log("deep link status:", deep.status(), "| editor mounted:", editor);
console.log("document text loaded:", /\w{6,}/.test(doc ?? ""), "| catalog aside:", catalog);
console.log(
  "marks rendered:",
  await page
    .locator(".cm-code-mark, .cm-tag")
    .count()
    .catch(() => 0),
);

// 3. the sidebar is the file explorer: its tree rows carry base-aware coding links
const links = await page.$$eval(".docs a", (as) => as.map((a) => a.getAttribute("href")));
console.log("sidebar document links:", links.slice(0, 3));

// 4. the old project-page URL is gone: served by 404.html, the catch-all redirects
//    home, and the root reopens the last document (the example one)
const proj = await page.goto(`${url}/project/example`);
const reopened = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
console.log(
  "old project URL status:",
  proj.status(),
  "| reopened the last document:",
  new URL(page.url()).pathname === `${BASE}/text/example/Junge%20Freiheit%2022`,
  "| editor mounted:",
  reopened,
);

// 5. visiting the root again reopens the last document (no start screen on a seeded profile)
await page.goto(`${url}/`);
const rootEditor = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
console.log(
  "root reopen:",
  new URL(page.url()).pathname === `${BASE}/text/example/Junge%20Freiheit%2022`,
  "| editor mounted:",
  rootEditor,
);

// 6. a sidebar document row opens its coding page
const docLink = page.locator('.docs a[href*="Junge"]').first();
await docLink.click();
// networkidle is unusable with a SharedWorker: the worker's connection is a
// permanent in-flight request — wait for the route + the editor instead
await page.waitForURL(/\/text\//, { timeout: 20000 });
const navEditor = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
console.log(
  "after doc nav:",
  new URL(page.url()).pathname,
  "| editor mounted:",
  navEditor,
  "| under base:",
  new URL(page.url()).pathname.startsWith(`${BASE}/`),
);

console.log("page problems:", problems.length ? problems.slice(0, 5) : "none");

// 4. any other unknown path under the base also boots the app shell
const stray = await page.goto(`${url}/text/does/not-exist`);
await page.waitForSelector("text=/does not exist|dashboard/i", { timeout: 20000 }).catch(() => {});
const strayText = (await page.textContent("body")) ?? "";
console.log("stray path status:", stray.status(), "| app shell booted:", /dashboard|exist/i.test(strayText));

await browser.close();
server.close();
