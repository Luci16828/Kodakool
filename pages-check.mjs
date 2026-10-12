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
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

// 1. prerendered homepage
const home = await page.goto(`${url}/`);
const homeText = await page.textContent("body");
console.log("home status:", home.status(), "| dashboard rendered:", /Projects/.test(homeText));

// example project seeds on first visit
const seeded = await page
  .waitForSelector("text=Junge Freiheit 22", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
console.log("example project seeded:", seeded);

// 2. deep link to a coding page: served by 404.html, client router takes over
const deep = await page.goto(`${url}/text/example/Junge%20Freiheit%2022`);
const editor = await page
  .waitForSelector(".cm-content", { timeout: 20000 })
  .then(() => true)
  .catch(() => false);
const doc = await page.textContent(".cm-content").catch(() => "");
const catalog = await page
  .waitForSelector("text=Devices", { timeout: 10000 })
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

// 3. client-side navigation inside the app (base-aware resolve() links)
const links = await page.$$eval("a", (as) => as.map((a) => a.getAttribute("href")));
console.log("links on coding page:", links.slice(0, 4));
const docLink = page.locator('a[href*="Junge"]').first();
await docLink.click();
await page.waitForLoadState("networkidle");
console.log(
  "after nav:",
  new URL(page.url()).pathname,
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
