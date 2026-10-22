/* Multi-tab live-sync campaign for the LOCAL account (SharedWorker):
   one browser context → one SharedWorker → tabs share store + rooms.
   Run inside the project in the devShell (dev server on :5173):
     direnv exec . node ./sync-campaign.mjs
   Prereq: fresh profile state is fine (example seeds itself); the campaign
   creates its own project `sync` so runs are self-contained. */
import { chromium } from "playwright";

const APP = "http://localhost:5173";
const results = [];
const check = (name, ok, extra = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  return ok;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // ONE context = one worker
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${tag} console: ${m.text().slice(0, 160)}`);
  });
};

async function openDoc(name, folder = "sync") {
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(`${APP}/text/${folder}/${encodeURIComponent(name)}`, { waitUntil: "domcontentloaded" });
  return page;
}

/* ---------- seed: create project sync + a document from the root page ---------- */
const A = await ctx.newPage();
watch(A, "A");
await A.goto(APP, { waitUntil: "domcontentloaded" });
await A.waitForURL(/\/text\//, { timeout: 25000 }).catch(() => undefined);
await A.waitForTimeout(2500);

// create project "sync" through the switcher's inline new-project row
await A.locator(".switchbtn").click();
await A.getByRole("option", { name: /new project/i })
  .click()
  .catch(async () => {
    // start screen path (fresh profile): the root page's New project button
    await A.getByRole("button", { name: /New project/ }).click();
  });
await A.getByLabel(/project name/i).fill("sync");
await A.getByRole("button", { name: /create/i }).click();
await A.waitForURL(/\/text\/sync\//, { timeout: 20000 }).catch(() => undefined);
await A.waitForSelector(".cm-content", { timeout: 20000 }).catch(() => undefined);
await A.waitForTimeout(1500);
check("project sync opened", A.url().includes("/text/sync/"), A.url().slice(0, 90));

/* ---------- 1. text typing both directions (live room) ---------- */
const B = await openDoc(decodeURIComponent(A.url().split("/text/sync/")[1] ?? ""));
await B.waitForSelector(".cm-content", { timeout: 20000 }).catch(() => undefined);
await B.getByRole("tab", { name: "Edit" }).click();
await A.getByRole("tab", { name: "Edit" }).click();
await A.click(".cm-content");
await A.keyboard.type("ALPHA-TYPED-IN-A ");
const bSawA = await B.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("ALPHA-TYPED-IN-A"),
  { timeout: 8000 },
)
  .then(() => true)
  .catch(() => false);
check("typing A → B (live)", bSawA);
await B.click(".cm-content");
await B.keyboard.type("BRAVO-IN-B");
const aSawB = await A.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("BRAVO-IN-B"),
  { timeout: 8000 },
)
  .then(() => true)
  .catch(() => false);
check("typing B → A (live)", aSawB);

/* ---------- 2. marking both directions (chips + tree counts) ---------- */
// arm a catalog device (the seeded example catalog is project-local; the sync
// project has none → add one via the catalog "New category" flow on A, then verify B)
await A.getByRole("tab", { name: "Coding" }).click();
await A.getByRole("button", { name: /New category/i }).click();
await A.waitForTimeout(400);
// edit mode: add a device row, then save
await A.getByRole("button", { name: /New code/i }).click();
await A.waitForTimeout(300);
const deviceInput = A.locator(".titem input").last();
await deviceInput.fill("LiveMarker");
await A.getByRole("button", { name: /Save catalog/i }).click();
const bSawCatalog = await B.waitForFunction(
  () => [...document.querySelectorAll(".tnode")].some((n) => n.textContent?.includes("LiveMarker")),
  {
    timeout: 8000,
  },
)
  .then(() => true)
  .catch(() => false);
check("catalog save A → B (live tree)", bSawCatalog);
await B.waitForTimeout(500);
// arm it on A and code the first word (smart click on the Coding tab)
await A.locator(".tnode", { hasText: "LiveMarker" }).first().click();
await A.locator(".cm-content").click({ position: { x: 60, y: 12 } });
await A.waitForTimeout(1200);
const bSawMark = await B.waitForFunction(() => document.querySelectorAll(".cm-tag, .cm-underline").length > 0, {
  timeout: 8000,
})
  .then(() => true)
  .catch(() => false);
check("marking A → B (live room)", bSawMark);

/* ---------- 3. snapshot in A moves B's Versions pill ---------- */
await A.getByRole("button", { name: /Versions \(/ }).click();
await A.getByRole("button", { name: /snapshot current state/i })
  .click()
  .catch(() => {});
const bVersions = await B.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Versions (1)")),
  {
    timeout: 9000,
  },
)
  .then(() => true)
  .catch(() => false);
check("snapshot A → B (versions pill live)", bVersions);

/* ---------- 4. new document in A appears in B's tree ---------- */
await A.getByLabel(/New document in/).click();
await A.waitForURL(/\/text\/sync\/Untitled/, { timeout: 15000 }).catch(() => undefined);
const bSawDoc = await B.waitForFunction(
  () => [...document.querySelectorAll(".doclist li")].some((l) => l.textContent?.includes("Untitled")),
  {
    timeout: 8000,
  },
)
  .then(() => true)
  .catch(() => false);
check("new doc A → B (live tree)", bSawDoc);

/* ---------- 5. cold deep link retries once the doc exists (C) ---------- */
const C = await openDoc("late.md");
await C.waitForTimeout(2500);
const cMissing = await C.getByText(/not available/i).count();
// rename the Untitled doc on A to late.md → C must recover WITHOUT reload
const aTitle = A.locator("h1 button.title");
await aTitle.click();
await A.getByLabel("Document name").fill("late.md");
await A.keyboard.press("Enter");
const cRecovered = await C.waitForFunction(() => !!document.querySelector(".cm-content"), { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check(`cold deep link missing→recover (C, pre-state missing=${cMissing > 0})`, cRecovered);
// closing C also closes its Yjs room conn → the room persists → row materializes
await C.close();
await A.waitForTimeout(1500);

/* ---------- 6. burst typing + marking (stress) ---------- */
// typing goes on the Edit tab (the Coding editor is read-only there); marking
// goes on the Coding tab — the room carries both
// the Coding tab is read-only: type on Edit (same room), then code on Coding
const bBurst = B.locator(".cm-content");
const bbox = await bBurst.boundingBox();
if (!bbox) throw new Error("B burst: no editor");
const lineAt = (frac) => ({ x: 60, y: Math.round(bbox.height * frac) });
await B.getByRole("tab", { name: "Edit" }).click();
await bBurst.click();
for (let i = 0; i < 4; i++) {
  await B.keyboard.type(`burst line ${i} content here.`);
  await B.keyboard.press("Enter");
}
await B.waitForTimeout(1200);
await B.getByRole("tab", { name: "Coding" }).click();
await B.waitForTimeout(900);
await B.locator(".tnode", { hasText: "LiveMarker" }).first().click();
for (const frac of [0.2, 0.45, 0.7]) {
  await bBurst.click({ position: lineAt(frac) });
  await B.waitForTimeout(300);
}
// B back on Edit: the Coding selection noise stops; the last persists materialize
// → A's tree count must follow (cross-tab marking via the store, no reload)
await B.getByRole("tab", { name: "Edit" }).click();
await B.waitForTimeout(1500);
console.log(
  "burst marks on B:",
  await B.locator(".cm-tag, .cm-underline").count(),
  "A tree:",
  (await A.locator(".doclist").first().textContent())?.replace(/\s+/g, " ").slice(0, 80),
);
// count what the room holds on B (marks/chips), then require A's count to reach
// at least 1 + half of B's marks (materialize lag + selection pseudo-marks)
const bMarks = await B.evaluate(() => document.querySelectorAll(".cm-tag").length);
const target = 1 + Math.floor(bMarks / 2);
const aAfterBurst = await A.waitForFunction(
  (t) => {
    const li = [...document.querySelectorAll(".doclist li")];
    // B's open doc is the FIRST one (B never navigated) — the marks live there
    const row = li.find((l) => l.textContent?.includes("Untitled 1.md"));
    // tree row text is `article <name> <codes> more_vert` — the LAST number is the
    // count (the name itself carries digits: "Untitled 1.md")
    const n = row ? parseInt(row.textContent.match(/(\d+)(?!.*\d)/)?.[1] ?? "0", 10) : 0;
    return n >= t;
  },
  target,
  { timeout: 12000 },
)
  .then(() => true)
  .catch(() => false);
check(`burst writes A's count follows B (live, B marks=${bMarks}, target=${target})`, aAfterBurst);

/* ---------- 6b. the cross-tab rename propagates (C opens the NEW url) ---------- */
const C2 = await openDoc("late.md");
const cSeesRenamed = await C2.waitForFunction(() => !!document.querySelector(".cm-content"), { timeout: 12000 })
  .then(() => true)
  .catch(() => false);
await C2.close();
check("rename A → opens in C at the new URL (live store)", cSeesRenamed);

/* ---------- 7. delete the doc B has open → B reload shows missing ---------- */
// row menus: synthetic click on the row's .menubtn pill (Bits anchors the menu
// at the pointer; a bare dispatched contextmenu is not a trusted event)
const delCountBefore = await B.locator(".doclist li").count();
// the open document's row carries class:current — that's late.md after the rename
const rowB = B.locator(".doclist li.current").first();
await rowB.locator(".menubtn").click();
const menuOnB = B.getByRole("menuitem", { name: /delete document/i });
console.log("delete menuitem on B:", await menuOnB.count());
await menuOnB.click();
// the shared confirm dialog: confirm button starts disabled with a 3s countdown
await B.waitForTimeout(3400);
await B.getByRole("dialog")
  .getByRole("button", { name: /^Confirm$/ })
  .click();
const aShrank = await A.waitForFunction((n) => document.querySelectorAll(".doclist li").length < n, delCountBefore, {
  timeout: 8000,
})
  .then(() => true)
  .catch(() => false);
check("delete in B visible in A's tree (live)", aShrank);
// deleting the OPEN document navigates to the root (app contract) and last-doc
// moves — deep-link the deleted URL to verify the store truth on a fresh load
await B.goto(APP + "/text/sync/" + encodeURIComponent("Untitled 1.md"), { waitUntil: "domcontentloaded" });
const bMissing = await B.waitForFunction(() => !!document.body.textContent?.includes("not available"), {
  timeout: 12000,
})
  .then(() => true)
  .catch(() => false);
if (!bMissing) {
  console.log(
    "B after deep link: url=",
    B.url().slice(-60),
    "body=",
    (await B.textContent("body"))?.replace(/\s+/g, " ").slice(0, 160),
  );
}
check("deleted-elsewhere doc shows missing on deep link", bMissing);

/* ---------- 8. project delete in A (cascade) → A navigates home, B goes missing ---------- */
await A.bringToFront();
await A.locator(".fgroup .menubtn").click();
await A.getByRole("menuitem", { name: /delete project/i }).click();
await A.waitForTimeout(3400); // confirm countdown
await A.getByRole("dialog")
  .getByRole("button", { name: /^Confirm$/ })
  .click();
const aGone = await A.waitForFunction(() => !location.pathname.includes("/text/sync/"), { timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check("project delete cascade (A navigates away)", aGone);
await B.reload({ waitUntil: "domcontentloaded" });
const bGone = await B.waitForFunction(() => !!document.body.textContent?.includes("not available"), {
  timeout: 12000,
})
  .then(() => true)
  .catch(() => false);
check("project delete visible in B (open doc now missing)", bGone);

console.log(results.join("\n"));
const noise = errors.filter((e) => !/Failed to load resource|favicon|net::ERR/.test(e));
console.log(noise.length ? `CONSOLE/PAGE NOISE:\n${noise.slice(0, 8).join("\n")}` : "no page errors");
const fails = results.filter((r) => r.startsWith("FAIL")).length;
console.log(fails === 0 && noise.length === 0 ? "CAMPAIGN ALL PASS" : `CAMPAIGN: ${fails} failures`);
await browser.close();
process.exit(fails === 0 && noise.length === 0 ? 0 : 1);
