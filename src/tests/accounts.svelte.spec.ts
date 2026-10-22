import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { localBackend, resetArticles, seedArticle } from "./fixtures";
import { ready, renderArticle, unmountArticle } from "./article-harness";
import { page } from "vitest/browser";

/**
 * The connect-server dialog adapts to the server: it probes GET /api/auth/methods
 * (fetch stubbed here — the real endpoint is proven by the server suite) and shows
 * only the sign-in methods that server supports, with the server's own OIDC
 * provider pre-filled. Build/profile presets become one-click targets.
 */
describe("connect server dialog (auth methods + presets)", () => {
  const realFetch = globalThis.fetch;

  function mockMethods(oidc: boolean) {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/auth/methods")) {
        return new Response(
          JSON.stringify({
            password: { enabled: true, register: true },
            oidc: oidc ? { enabled: true, issuer: "https://id.mock", clientId: "kodakool" } : { enabled: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return realFetch(input as RequestInfo, init);
    });
  }

  beforeAll(async () => {
    localBackend();
    await resetArticles();
  });

  afterEach(async () => {
    unmountArticle();
    vi.unstubAllGlobals();
    localStorage.removeItem("luci-server-presets");
    await resetArticles();
  });

  async function openDialogWithUrl(url: string): Promise<void> {
    await page.getByRole("button", { name: "Connect server" }).click();
    await page.getByLabelText("Server URL").fill(url);
  }

  it("probes the server and pre-fills its advertised OIDC provider", async () => {
    mockMethods(true);
    await seedArticle({ project: "acc", name: "n.md", text: "x" });
    renderArticle("n.md", "acc");
    await ready();
    await openDialogWithUrl("https://kodakool.mock");
    // the probe line names exactly what the server supports
    await expect.element(page.getByText("server ok: sign-in + signup + OIDC")).toBeInTheDocument();
    // OIDC tab exists only because the server advertises it — the provider arrives filled in
    await page.getByRole("tab", { name: "OIDC sign-in" }).click();
    await expect.element(page.getByLabelText("OIDC issuer")).toHaveValue("https://id.mock");
    await expect.element(page.getByLabelText("OIDC client id")).toHaveValue("kodakool");
  });

  it("offers only password sign-in on a server without OIDC", async () => {
    mockMethods(false);
    await seedArticle({ project: "acc", name: "n.md", text: "x" });
    renderArticle("n.md", "acc");
    await ready();
    await openDialogWithUrl("https://plain.mock");
    await expect.element(page.getByText("server ok: sign-in + signup")).toBeInTheDocument();
    await expect.element(page.getByRole("tab", { name: "OIDC sign-in" }).first()).not.toBeInTheDocument();
  });

  it("offers preset servers as one-click targets (invalid entries never render)", async () => {
    localStorage.setItem("luci-server-presets", "https://preset.example, garbage, http://ok.example/");
    mockMethods(false);
    await seedArticle({ project: "acc", name: "n.md", text: "x" });
    renderArticle("n.md", "acc");
    await ready();
    await page.getByRole("button", { name: "Connect server" }).click();
    const chip = page.getByRole("button", { name: "preset.example" });
    await expect.element(chip).toBeInTheDocument();
    await chip.click();
    await expect.element(page.getByLabelText("Server URL")).toHaveValue("https://preset.example");
    // the label auto-fills with the host, the garbage entry is never offered
    await expect.element(page.getByLabelText("Account label")).toHaveValue("preset.example");
    await expect.element(page.getByRole("button", { name: "garbage" }).first()).not.toBeInTheDocument();
  });
});
