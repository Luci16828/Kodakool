import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import CatalogTree from "./CatalogTree.svelte";
import type { CatalogView } from "$lib/coding/catalog-view";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const PLAIN_ID = "33333333-3333-4333-8333-333333333333";

function node(id: string, code: string, name: string, children: CatalogView[] = []): CatalogView {
  return { id, code, name, kind: children.length ? "element" : "device", count: 0, slug: null, children };
}

/** `1 Rahmen > 1.1 Zitat` plus a plain `2 Kommentar` leaf. */
function catalog(): CatalogView[] {
  return [node(GROUP_ID, "1", "Rahmen", [node(CHILD_ID, "1.1", "Zitat")]), node(PLAIN_ID, "2", "Kommentar")];
}

const items = () => page.getByRole("treeitem");
/** rows are addressed by their accessible name (`code name count`) */
const item = (name: string) => page.getByRole("treeitem", { name });

async function itemCount(): Promise<number> {
  return (await items().all()).length;
}

/** text of the `.tcount` span of the row containing `name` */
function countText(name: string): string | null {
  const row = [...document.querySelectorAll(".tnode")].find((r) => r.textContent?.includes(name));
  return row?.querySelector(".tcount")?.textContent ?? null;
}

describe("CatalogTree.svelte", () => {
  it("renders every node with its derived code and name", async () => {
    render(CatalogTree, { catalog: catalog() });

    await expect.poll(itemCount).toBe(3);
    await expect.element(item("1.1")).toBeInTheDocument();
    await expect.element(page.getByText("Zitat")).toBeInTheDocument();
    await expect.element(page.getByText("Kommentar")).toBeInTheDocument();
  });

  it("sums the counts of a group and its children", async () => {
    render(CatalogTree, {
      catalog: catalog(),
      counts: new Map<string, number>([
        [CHILD_ID, 2],
        [PLAIN_ID, 1],
      ]),
    });

    await expect.poll(() => countText("Zitat")).toBe("2");
    await expect.poll(() => countText("Rahmen")).toBe("2");
  });

  it("falls back to the server count on each node when no counts map is given", async () => {
    const cat = catalog();
    cat[0].count = 5;
    cat[0].children[0].count = 3;
    render(CatalogTree, { catalog: cat });

    await expect.poll(() => countText("Rahmen")).toBe("8");
    await expect.poll(() => countText("Kommentar")).toBe("");
  });

  it("marks nodes without any entry as unused", async () => {
    render(CatalogTree, { catalog: catalog(), counts: new Map([[PLAIN_ID, 1]]) });

    await expect.element(item("Zitat")).toBeInTheDocument();
    await expect.element(item("Rahmen")).toHaveClass("unused");
    await expect.element(item("Kommentar")).not.toHaveClass("unused");
  });

  it("arms a leaf device on click and marks it selected", async () => {
    const onpick = vi.fn();
    const { rerender } = render(CatalogTree, { catalog: catalog(), onpick });

    await item("Zitat").click();
    expect(onpick).toHaveBeenCalledWith(CHILD_ID);

    await rerender({ selected: CHILD_ID });
    await expect.element(item("Zitat")).toHaveClass("sel");
    await expect.element(item("Kommentar")).not.toHaveClass("sel");
  });

  it("toggles a group instead of picking it", async () => {
    const onpick = vi.fn();
    render(CatalogTree, { catalog: catalog(), onpick });

    await expect.poll(itemCount).toBe(3);
    await item("Rahmen").click();
    await expect.poll(itemCount).toBe(2);
    await expect.element(page.getByText("Zitat")).not.toBeInTheDocument();
    expect(onpick).not.toHaveBeenCalled();

    await item("Rahmen").click();
    await expect.poll(itemCount).toBe(3);
    await expect.element(page.getByText("Zitat")).toBeInTheDocument();
  });

  it("reports the hovered node id and clears it on leave", async () => {
    const onhover = vi.fn();
    render(CatalogTree, { catalog: catalog(), onhover });

    await item("Zitat").hover();
    expect(onhover).toHaveBeenCalledWith(CHILD_ID);

    onhover.mockClear();
    await item("Zitat").unhover();
    expect(onhover).toHaveBeenCalledWith(null);
  });

  it("renders the slug short label with its bold segments", async () => {
    const cat = [node(PLAIN_ID, "2", "Transaktive Berichterstattung")];
    cat[0].slug = {
      short: "TB",
      bold: [
        { start: 0, len: 1 },
        { start: 12, len: 1 },
      ],
    };
    render(CatalogTree, { catalog: cat });

    await expect.element(page.getByText("TB")).toBeInTheDocument();
    await expect.element(page.getByText("Transaktive Berichterstattung")).toBeInTheDocument();
    await expect.poll(() => document.querySelectorAll(".tname b").length).toBe(2);
    await expect.poll(() => [...document.querySelectorAll(".tname b")].map((b) => b.textContent)).toEqual(["T", "B"]);
  });

  it("does not pick a legacy node whose id is not a device uuid", async () => {
    const onpick = vi.fn();
    render(CatalogTree, { catalog: [node("1.2 legacy", "1.2", "Ohne Katalog")], onpick });

    await item("Ohne Katalog").click();
    expect(onpick).not.toHaveBeenCalled();
  });

  it("edit mode renders name/tag inputs and disables picking", async () => {
    const onpick = vi.fn();
    const onrename = vi.fn();
    const ontag = vi.fn();
    render(CatalogTree, { catalog: catalog(), editing: true, onpick, onrename, ontag });

    await item("Zitat").click();
    expect(onpick).not.toHaveBeenCalled();

    await page.getByRole("textbox", { name: "name Zitat" }).fill("Markierung");
    expect(onrename).toHaveBeenCalledWith(CHILD_ID, "Markierung");

    await page.getByRole("textbox", { name: "tag Kommentar" }).fill("K2");
    expect(ontag).toHaveBeenCalledWith(PLAIN_ID, "K2");
  });
});
