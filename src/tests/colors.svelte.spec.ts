import { page, userEvent } from "vitest/browser";
import { afterAll, describe, expect, it } from "vitest";
import { render } from "vitest-browser-svelte";
import ColorProvider from "./ColorProvider.svelte";
import ColorPanel from "../lib/coding/ColorPanel.svelte";
import { THEME_SOURCE, themeTokens } from "$lib/coding/palette";

const COLORS_KEY = "coding-colors";

/** the color controls, mounted under the same color store the root layout provides */
function renderColors() {
  return render(ColorPanel, {}, { wrapper: ColorProvider });
}

const colorInput = () => page.getByLabelText("base color");
// the bar renders chroma before tone
const chromaSlider = () => page.getByRole("slider").first();
const toneSlider = () => page.getByRole("slider").nth(1);

function stored(): Record<string, unknown> | null {
  const raw = localStorage.getItem(COLORS_KEY);
  return raw === null ? null : JSON.parse(raw);
}

afterAll(() => localStorage.removeItem(COLORS_KEY));

describe("colors page", () => {
  it("shows the theme tokens derived from the current source color", async () => {
    renderColors();

    await expect.element(page.getByRole("heading", { level: 2, name: "Colors" })).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".token").length).toBe(9);

    const source = (document.querySelector('input[type="color"]') as HTMLInputElement).value;
    const tokens = themeTokens(source);
    await expect.element(page.getByText(tokens.light.primary).first()).toBeInTheDocument();
    await expect.element(page.getByText(tokens.dark.primary).first()).toBeInTheDocument();
  });

  it("re-tints every token swatch when the base color changes", async () => {
    renderColors();
    const before = themeTokens((document.querySelector('input[type="color"]') as HTMLInputElement).value);

    await colorInput().fill("#c00000");

    await expect.element(page.getByText("#c00000").first()).toBeInTheDocument();
    await expect.element(page.getByText(themeTokens("#c00000").light.primary).first()).toBeInTheDocument();
    await expect.element(page.getByText(before.light.primary).first()).not.toBeInTheDocument();
  });

  it("adjusts marker chroma and tone through the sliders", async () => {
    const { wrapper } = renderColors();

    await chromaSlider().element().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    await toneSlider().element().focus();
    await userEvent.keyboard("{ArrowLeft}");

    await expect.element(chromaSlider()).toHaveValue("2");
    await expect.element(toneSlider()).toHaveValue("-1");
    await expect.element(page.getByText("+2")).toBeInTheDocument();
    expect(wrapper.prefs.chromaAdj).toBe(2);
    expect(wrapper.prefs.toneAdj).toBe(-1);
  });

  it("restores every control with reset all", async () => {
    const { wrapper } = renderColors();

    await colorInput().fill("#00b050");
    await chromaSlider().element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByText("#00b050")).toBeInTheDocument();

    await page.getByRole("button", { name: "reset all" }).click();

    await expect.element(colorInput()).toHaveValue(THEME_SOURCE);
    await expect.element(chromaSlider()).toHaveValue("0");
    expect(wrapper.prefs.themeSource).toBe(THEME_SOURCE);
    expect(wrapper.prefs.chromaAdj).toBe(0);
  });

  it("previews the marker palette for the sample codes", async () => {
    renderColors();

    await expect.poll(() => document.querySelectorAll(".palette li").length).toBe(8);
    // every sample code is previewed once in the light and once in the dark scheme
    await expect.poll(() => document.querySelectorAll(".palette .chip").length).toBe(16);
    for (const code of ["1.1", "2.1", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1"]) {
      await expect.element(page.getByText(code, { exact: true }).first()).toBeInTheDocument();
    }
  });

  it("persists the color preferences to localStorage", async () => {
    renderColors();

    await chromaSlider().element().focus();
    await userEvent.keyboard("{ArrowRight}");

    await expect.poll(() => stored()?.chromaAdj).toBe(1);
  });
});
