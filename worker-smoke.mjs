// Local-worker architecture smoke: root page → worker store → coding page → live collab
import { chromium } from "playwright";

const APP = "http://localhost:5173";
const browser = await chromium.launch();
// ONE context: pages in the same context share localStorage, IndexedDB and the
// SharedWorker (browser.newPage() would create isolated contexts = separate profiles)
const context = await browser.newContext();
const page = await context.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300)));
page.on("request", (r) => {
  if (r.url().includes("worker")) console.log("REQ", r.url().slice(0, 130));
});
page.on("console", (m) => {
  console.log("LOG", m.type(), m.text().slice(0, 200));
});

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000); // worker boot + wasm init + seed

const url = page.url();
console.log("after root:", url);

const start = await page.getByText("Nothing open yet").count();
console.log("start screen:", start > 0);

if (start > 0) {
  await page.getByRole("button", { name: /New project/ }).click();
  await page.getByLabel("New project name").fill("smoke");
  await page.getByRole("button", { name: "create" }).click();
  await page.waitForURL(/\/text\/smoke\//, { timeout: 20000 });
}

await page.waitForTimeout(6000);
console.log("URL now:", page.url());
console.log("BODY:", (await page.textContent("body"))?.slice(0, 200));
await page.waitForSelector(".cm-content", { timeout: 20000 });
console.log("editor visible:", await page.isVisible(".cm-content"));
console.log("BODY:", (await page.textContent("body"))?.slice(0, 200));

// type on the Edit tab, reload, expect persistence through the worker
await page.getByRole("tab", { name: "Edit" }).click();
await page.click(".cm-content");
await page.keyboard.type("worker text 12345");
await page.waitForTimeout(2500);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cm-content", { timeout: 20000 });
const text = await page.textContent(".cm-content");
console.log("persisted after reload:", text?.includes("worker text 12345"));

// sidebar tree shows the project of the open document
const proj = decodeURIComponent(page.url().split("/text/")[1].split("/")[0]);
console.log("tree shows project:", (await page.textContent(".fgroup"))?.includes(proj));

/* ----- two tabs on the SAME document: live collaboration through the worker room ----- */
const pageB = await context.newPage({ viewport: { width: 1280, height: 900 } });
pageB.on("pageerror", (e) => console.log("PAGEERROR B:", e.message.slice(0, 300)));
await pageB.goto(page.url(), { waitUntil: "domcontentloaded" });
await pageB.waitForSelector(".cm-content", { timeout: 20000 });
await pageB.getByRole("tab", { name: "Edit" }).click();
// the Coding tab is read-only — typing must happen on the Edit tab on BOTH sides
await page.getByRole("tab", { name: "Edit" }).click();
await page.click(".cm-content");
await page.keyboard.type("LIVE-COLLAB-MARKER");
// the second tab must show the typing without a reload
const bSaw = await pageB
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("LIVE-COLLAB-MARKER"), {
    timeout: 8000,
  })
  .then(() => true)
  .catch(() => false);
console.log("live sync tab B sees tab A:", bSaw);

// and the other direction
await pageB.click(".cm-content");
await pageB.keyboard.type("-BACK");
const aSaw = await page
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("-BACK"), { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
console.log("live sync tab A sees tab B:", aSaw);

await browser.close();
