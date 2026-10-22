/* Live collaboration smoke test: two browsers, one remote document, live Yjs sync.
   Run inside the project (ESM resolution) in the devShell:
     direnv exec . node ./collab-smoke.mjs
   Prereq: collab server on :8791, app dev server on :5173. */
import { chromium } from "playwright";

const SERVER = "http://127.0.0.1:8791";
const APP = "http://localhost:5173";

async function api(path, body, token) {
  const res = await fetch(SERVER + path, {
    method: body ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}

const stamp = Date.now();
const a = await api("/api/auth/register", { email: `a${stamp}@x.dev`, password: "passw0rd!A", name: "Ada" });
const b = await api("/api/auth/register", { email: `b${stamp}@x.dev`, password: "passw0rd!B", name: "Bob" });

const proj = await api("/api/projects", { name: "team" }, a.token);
const doc = await api(`/api/projects/${proj.id}/docs`, { name: "shared", text: "hello from A" }, a.token);
await api(`/api/projects/${proj.id}/share`, { email: `b${stamp}@x.dev` }, a.token);

const urlA = `${APP}/text/accA/team/shared`;
const urlB = `${APP}/text/accB/team/shared`;
const browser = await chromium.launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctxA.addInitScript(
  ([acc]) => localStorage.setItem("luci-accounts", JSON.stringify([acc])),
  [
    {
      id: "accA",
      kind: "remote",
      label: "A server",
      serverUrl: SERVER,
      token: a.token,
      refresh: a.refresh,
      user: a.user,
    },
  ],
);
await ctxB.addInitScript(
  ([acc]) => localStorage.setItem("luci-accounts", JSON.stringify([acc])),
  [
    {
      id: "accB",
      kind: "remote",
      label: "B server",
      serverUrl: SERVER,
      token: b.token,
      refresh: b.refresh,
      user: b.user,
    },
  ],
);

const pageA = await ctxA.newPage();
const pageB = await ctxB.newPage();
pageA.on("pageerror", (e) => console.log("A pageerror:", e.message.slice(0, 300)));
pageB.on("pageerror", (e) => console.log("B pageerror:", e.message.slice(0, 300)));
pageA.on("console", (m) => m.type() === "error" && console.log("A console:", m.text().slice(0, 200)));
pageB.on("console", (m) => m.type() === "error" && console.log("B console:", m.text().slice(0, 200)));

await pageA.goto(urlA, { waitUntil: "domcontentloaded" });
await pageB.goto(urlB, { waitUntil: "domcontentloaded" });

const ok = [];
const check = (name, cond) => {
  ok.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};

// both editors show the seeded text
await pageA.waitForSelector(".cm-content", { timeout: 15000 });
await pageB.waitForSelector(".cm-content", { timeout: 15000 });
await pageA
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("hello from A"), undefined, {
    timeout: 15000,
  })
  .catch(() => {});
await pageB
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("hello from A"), undefined, {
    timeout: 15000,
  })
  .catch(() => {});
check("A shows seeded text", (await pageA.textContent(".cm-content"))?.includes("hello from A"));
check("B shows seeded text (room seed)", (await pageB.textContent(".cm-content"))?.includes("hello from A"));

// live text sync: type in A (Edit tab — the Coding tab keeps the body read-only), watch B
await pageA.getByRole("tab", { name: "Edit" }).click();
await pageA.click(".cm-content");
await pageA.keyboard.press("End");
await pageA.keyboard.type(" + B sees me");
await pageB
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("B sees me"), undefined, {
    timeout: 10000,
  })
  .catch(() => {});
check("A's typing arrives in B", (await pageB.textContent(".cm-content"))?.includes("B sees me"));

// typing back the other way
await pageB.getByRole("tab", { name: "Edit" }).click();
await pageB.bringToFront();
await pageB.click(".cm-content");
await pageB.keyboard.press("End");
await pageB.keyboard.type(" + A sees me");
await pageA
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("A sees me"), undefined, {
    timeout: 10000,
  })
  .catch(() => {});
check("B's typing arrives in A", (await pageA.textContent(".cm-content"))?.includes("A sees me"));

// presence: each page shows the other's name chip
await pageA.waitForSelector(".peer", { timeout: 10000 }).catch(() => {});
check("A shows peer chip (Bob)", (await pageA.textContent(".peers"))?.includes("Bob"));
check("B shows peer chip (Ada)", (await pageB.textContent(".peers"))?.includes("Ada"));

// live sync pill
check("A shows live pill", (await pageA.textContent(".sync"))?.includes("live"));

// persistence: reload A, text survives through the server room
await pageA.reload({ waitUntil: "domcontentloaded" });
await pageA.waitForSelector(".cm-content", { timeout: 15000 });
await pageA
  .waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("A sees me"), undefined, {
    timeout: 15000,
  })
  .catch(() => {});
check("reload keeps the merged text", (await pageA.textContent(".cm-content"))?.includes("A sees me"));

// REST materialization: the server's doc row carries the live text
const rest = await api(`/api/docs/${doc.id}`, null, a.token);
check("server REST reflects the text", rest.text.includes("B sees me") && rest.text.includes("A sees me"));

await browser.close();
const failed = ok.filter(([, c]) => !c).length;
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
