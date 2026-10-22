/* Remote-account campaign: app ↔ networked server interactions.
   Two isolated browser contexts = two users on two machines, one collab server.
   Run inside the project in the devShell:
     direnv exec . node ./remote-campaign.mjs
   Prereq: collab server on :8791 (ALLOW_REGISTER=1), app dev server on :5173.
   Proves: room seed, WS typing both ways, presence, and the SSE live channels —
   catalog save, new doc, DELETE, cross-account project sharing, and the
   idle-coalesced Versions-pill refresh (the scheduleVersionsRefresh wiring). */
import { chromium } from "playwright";

const SERVER = "http://127.0.0.1:8791";
const APP = "http://localhost:5173";

async function req(method, path, body, token) {
  const res = await fetch(SERVER + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });
  const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}
const api = (path, body, token) => req(body ? "POST" : "GET", path, body, token);

const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  return ok;
};

/* ---------- server-side setup: two accounts, one shared project ---------- */
const methods = await api("/api/auth/methods", null, null);
check(
  "GET /api/auth/methods is public + honest (password on, OIDC off unconfigured)",
  methods.password?.enabled === true && methods.password?.register === true && methods.oidc?.enabled === false,
);
const stamp = Date.now();
const a = await api("/api/auth/register", { email: `ra${stamp}@x.dev`, password: "passw0rd!RA", name: "Ada" });
const b = await api("/api/auth/register", { email: `rb${stamp}@x.dev`, password: "passw0rd!RB", name: "Bob" });
const proj = await api("/api/projects", { name: "team" }, a.token);
const doc = await api(`/api/projects/${proj.id}/docs`, { name: "shared", text: "hello remote base" }, a.token);
await api(`/api/projects/${proj.id}/share`, { email: `rb${stamp}@x.dev` }, a.token);

const browser = await chromium.launch();
const seed =
  (acc) =>
  async ([account]) => {
    // addInitScript also runs on about:blank, where localStorage is denied
    try {
      localStorage.setItem("luci-accounts", JSON.stringify([account]));
    } catch {}
  };
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctxA.addInitScript(seed("A"), [
  {
    id: "accA",
    kind: "remote",
    label: "A server",
    serverUrl: SERVER,
    token: a.token,
    refresh: a.refresh,
    user: a.user,
  },
]);
await ctxB.addInitScript(seed("B"), [
  {
    id: "accB",
    kind: "remote",
    label: "B server",
    serverUrl: SERVER,
    token: b.token,
    refresh: b.refresh,
    user: b.user,
  },
]);
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message.slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|Failed to load resource/i.test(m.text()))
      errors.push(`${tag} console: ${m.text().slice(0, 160)}`);
  });
};
const A = await ctxA.newPage();
const B = await ctxB.newPage();
watch(A, "A");
watch(B, "B");

const sharedUrl = (acc) => `${APP}/text/${acc}/team/shared`;
await A.goto(sharedUrl("accA"), { waitUntil: "domcontentloaded" });
await B.goto(sharedUrl("accB"), { waitUntil: "domcontentloaded" });
await A.waitForSelector(".cm-content", { timeout: 20000 });
await B.waitForSelector(".cm-content", { timeout: 20000 });

/* ---------- 1. room seed ---------- */
const seedOk =
  (await A.textContent(".cm-content"))?.includes("hello remote base") &&
  (await B.textContent(".cm-content"))?.includes("hello remote base");
check("both accounts open the shared doc (room seed)", seedOk);

/* ---------- 2. WS typing both directions ---------- */
await A.getByRole("tab", { name: "Edit" }).click();
await A.click(".cm-content");
await A.keyboard.press("End");
await A.keyboard.type(" ALPHA-REMOTE");
const bSawA = await B.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("ALPHA-REMOTE"),
  { timeout: 10000 },
)
  .then(() => true)
  .catch(() => false);
check("typing A → B (WS room)", bSawA);
await B.getByRole("tab", { name: "Edit" }).click();
await B.click(".cm-content");
await B.keyboard.press("End");
await B.keyboard.type(" BRAVO-REMOTE");
const aSawB = await A.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("BRAVO-REMOTE"),
  { timeout: 10000 },
)
  .then(() => true)
  .catch(() => false);
check("typing B → A (WS room)", aSawB);

/* ---------- 3. presence ---------- */
await A.waitForSelector(".peer", { timeout: 10000 }).catch(() => {});
const presence =
  (await A.textContent(".peers"))?.includes("Bob") &&
  (await B.textContent(".peers"))?.includes("Ada") &&
  (await A.textContent(".sync"))?.includes("live");
check("peer chips both ways + live pill", presence);

/* ---------- 4. catalog saved by A reaches B's sidebar (SSE catalog) ---------- */
const catalog = {
  version: 1,
  title: "Team codes",
  devices: [{ id: crypto.randomUUID(), name: "RemoteCat", kind: "device", examples: [], children: [] }],
};
await req("PUT", `/api/projects/${proj.id}/catalog`, { data: catalog }, a.token);
const bSawCatalog = await B.waitForFunction(
  () => [...document.querySelectorAll(".tnode")].some((n) => n.textContent?.includes("RemoteCat")),
  {
    timeout: 10000,
  },
)
  .then(() => true)
  .catch(() => false);
check("catalog A → B sidebar (SSE)", bSawCatalog);

/* ---------- 5. new doc by A appears in B's tree (SSE docs) ---------- */
const late = await api(`/api/projects/${proj.id}/docs`, { name: "late-remote", text: "created by A" }, a.token);
const bSawDoc = await B.waitForFunction(
  () => [...document.querySelectorAll(".doclist li")].some((l) => l.textContent?.includes("late-remote")),
  {
    timeout: 10000,
  },
)
  .then(() => true)
  .catch(() => false);
check("new doc A → B tree (SSE)", bSawDoc);

/* ---------- 6. snapshot by A moves B's Versions pill (idle-coalesced) ---------- */
const full = await api(`/api/docs/${doc.id}`, null, a.token);
await api(`/api/docs/${doc.id}/versions`, { text: full.text, codes: full.codes, label: "remote snap" }, a.token);
const bPill = await B.waitForFunction(
  () => [...document.querySelectorAll("button")].some((x) => x.textContent?.includes("Versions (1)")),
  {
    timeout: 12000,
  },
)
  .then(() => true)
  .catch(() => false);
check("snapshot A → B Versions pill (SSE + 2 s coalesce)", bPill);

/* ---------- 7. cross-account sharing: A creates team2, shares it, B's
   switcher lists it without a reload (SSE project → refreshProjects) ---------- */
const team2 = await api("/api/projects", { name: "team2" }, a.token);
await api(`/api/projects/${team2.id}/share`, { email: `rb${stamp}@x.dev` }, a.token);
// open B's switcher dropdown and look for the shared project row
const bSwitcher = await (async () => {
  await B.locator(".switchbtn").click();
  const opt = B.getByRole("option", { name: /team2/ }); // label carries the server suffix: "team2 · B server"
  let found = await opt
    .waitFor({ state: "attached", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!found) console.log("B switcher options:", JSON.stringify(await B.locator('[role="option"]').allTextContents()));
  await B.keyboard.press("Escape");
  return found;
})();
check("shared project A → B switcher (SSE)", bSwitcher);

/* ---------- 8. doc DELETE by A removes B's row live ---------- */
await req("DELETE", `/api/docs/${late.id}`, undefined, a.token);
const bRowGone = await B.waitForFunction(
  () => ![...document.querySelectorAll(".doclist li")].some((l) => l.textContent?.includes("late-remote")),
  { timeout: 10000 },
)
  .then(() => true)
  .catch(() => false);
check("delete A → B tree live (SSE)", bRowGone);

/* ---------- 9. deep link to the deleted doc: missing screen on B ---------- */
await B.goto(`${APP}/text/accB/team/late-remote`, { waitUntil: "domcontentloaded" });
const bMissing = await B.waitForFunction(() => !!document.body.textContent?.includes("not available"), {
  timeout: 12000,
})
  .then(() => true)
  .catch(() => false);
check("deleted doc deep link → missing on B", bMissing);

/* ---------- 10. persistence: B returns to the shared doc after reload ---------- */
await B.goto(sharedUrl("accB"), { waitUntil: "domcontentloaded" });
await B.waitForSelector(".cm-content", { timeout: 20000 });
const persisted = await B.waitForFunction(
  () => document.querySelector(".cm-content")?.textContent?.includes("ALPHA-REMOTE") === true,
  { timeout: 15000 },
)
  .then(() => true)
  .catch(() => false);
check("reload keeps the merged text (materialize)", persisted);

/* ---------- server truth ---------- */
const rest = await api(`/api/docs/${doc.id}`, null, b.token);
check(
  "server REST reflects both accounts' text",
  rest.text.includes("ALPHA-REMOTE") && rest.text.includes("BRAVO-REMOTE"),
);

console.log(
  `\n${
    results.filter(([, c]) => !c).length === 0
      ? "REMOTE CAMPAIGN ALL PASS"
      : "FAILURES: " +
        results
          .filter(([, c]) => !c)
          .map(([n]) => n)
          .join("; ")
  }`,
);
const noise = errors.filter((e) => !/Failed to load resource|favicon|net::ERR/i.test(e));
console.log(noise.length ? `NOISE:\n${noise.slice(0, 8).join("\n")}` : "no page errors");
await browser.close();
process.exit(results.every(([, c]) => c) && noise.length === 0 ? 0 : 1);
