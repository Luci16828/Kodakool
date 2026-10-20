<script lang="ts" module>
  import type { CatalogView } from "$lib/coding/catalog-view";
</script>

<script lang="ts">
  import { Tree } from "melt/builders";
  import { flip } from "svelte/animate";
  import { slide } from "svelte/transition";
  import "material-symbols/rounded.css";
  import { openRowMenu } from "$lib/coding/context-menu";
  import { UUID_RE } from "$lib/coding/instructions";
  import RowMenu from "$lib/coding/RowMenu.svelte";
  import type { Slug } from "./shortlabel";

  let {
    catalog,
    counts = null,
    selected = null,
    styleFor = () => "",
    onpick,
    onhover,
    editing = false,
    onrename,
    ontag,
    onmove,
    onadd,
    onaddbelow,
    ondelete,
  }: {
    catalog: CatalogView[];
    /** per-node counts keyed by catalog id; null falls back to the server count on each node */
    counts?: Map<string, number> | null;
    /** catalog id of the currently selected (armed) device */
    selected?: string | null;
    /** css custom properties applied to each node row (e.g. --marker, --fill) */
    styleFor?: (node: CatalogView) => string;
    /** called with the device id when a pickable leaf row is clicked */
    onpick?: (id: string) => void;
    onhover?: (id: string | null) => void;
    /** inline editing: name/tag inputs + drag reordering (picks disabled) */
    editing?: boolean;
    onrename?: (id: string, name: string) => void;
    /** empty tag string clears the override (auto slug returns) */
    ontag?: (id: string, tag: string) => void;
    /** drop `dragId` onto `targetId` (reorders within the target's sibling list) */
    onmove?: (dragId: string, targetId: string) => void;
    /** add a child device under `id` (edit mode) */
    onadd?: (id: string) => void;
    /** add a sibling device directly below `id` (edit mode) */
    onaddbelow?: (id: string) => void;
    /** request deletion of the device `id` (edit mode; parent confirms) */
    ondelete?: (id: string) => void;
  } = $props();

  /** row currently being dragged / currently a drop target (edit mode only) */
  let dragId = $state<string | null>(null);
  let dropId = $state<string | null>(null);

  function expandableIds(ns: CatalogView[], acc: string[] = []): string[] {
    for (const n of ns) {
      if (n.children.length) {
        acc.push(n.id);
        expandableIds(n.children, acc);
      }
    }
    return acc;
  }

  const tree = $derived(
    new Tree({
      items: catalog,
      multiple: true,
      expanded: new Set(expandableIds(catalog)),
    }),
  );
  type TreeNode = (typeof tree.children)[number];

  function countOf(n: TreeNode): number {
    const own = counts === null ? n.item.count : (counts.get(n.item.id) ?? 0);
    return own + (n.children?.reduce((s, c) => s + countOf(c), 0) ?? 0);
  }

  function codeId(code: string): string {
    return /^[0-9]+(?:\.[0-9]+)*/.exec(code)?.[0] ?? code;
  }

  function boldSegments(name: string, slug: Slug | null): { t: string; b: boolean }[] {
    if (!slug || slug.bold.length === 0) return name ? [{ t: name, b: false }] : [];
    const out: { t: string; b: boolean }[] = [];
    let i = 0;
    for (const p of [...slug.bold].sort((a, b) => a.start - b.start)) {
      if (p.start > i) out.push({ t: name.slice(i, p.start), b: false });
      out.push({ t: name.slice(p.start, p.start + p.len), b: true });
      i = p.start + p.len;
    }
    if (i < name.length) out.push({ t: name.slice(i, name.length), b: false });
    return out;
  }

  function click(n: TreeNode): void {
    // in edit mode a row click must never collapse the subtree — the caret does that
    if (editing) return;
    if (n.canExpand) {
      n.toggleExpand();
      return;
    }
    if (UUID_RE.test(n.item.id)) onpick?.(n.item.id);
  }
</script>

{#snippet nodes(children: TreeNode[])}
  {#each children as n (n.id)}
    {@const droppable = editing && dragId !== null && dragId !== n.item.id}
    <!-- keyed wrapper: animate:flip needs the animated element to be the each block's only child -->
    <div class="titem" animate:flip={{ duration: 180 }}>
      <RowMenu
        items={[
          ...(editing || !UUID_RE.test(n.item.id) || n.item.kind !== "device" || n.canExpand
            ? []
            : [{ label: "Code with this device", icon: "edit_note", onSelect: () => onpick?.(n.item.id) }]),
          ...(onadd ? [{ label: "New child code", icon: "tab_new_right", onSelect: () => onadd(n.item.id) }] : []),
          ...(onaddbelow ? [{ label: "New below", icon: "add_row_below", onSelect: () => onaddbelow(n.item.id) }] : []),
          ...(ondelete
            ? [{ label: "Delete", icon: "delete", danger: true, sep: true, onSelect: () => ondelete(n.item.id) }]
            : []),
        ]}
      >
        {#snippet trigger({ props }: { props: Record<string, unknown> })}
          {@const { style: triggerStyle, ...rest } = props}
          <div
            {...n.attrs}
            class="tnode"
            class:edit={editing}
            class:group={n.canExpand}
            class:unused={countOf(n) === 0}
            class:sel={selected === n.item.id}
            class:drop={droppable && dropId === n.item.id}
            class:dragging={dragId === n.item.id}
            data-kind={n.item.kind}
            style={`${styleFor(n.item)};pointer-events:auto`}
            onmouseenter={() => onhover?.(n.item.id)}
            onmouseleave={() => onhover?.(null)}
            onclick={() => click(n)}
            ondragover={(e) => {
              if (droppable) {
                e.preventDefault();
                dropId = n.item.id;
              }
            }}
            ondragleave={() => {
              if (dropId === n.item.id) dropId = null;
            }}
            ondrop={(e) => {
              if (dragId !== null) {
                e.preventDefault();
                onmove?.(dragId, n.item.id);
              }
              dragId = null;
              dropId = null;
            }}
            {...rest}
          >
            {#if editing}
              <span
                class="grip material-symbols-rounded"
                draggable="true"
                title="Drag to reorder"
                aria-hidden="true"
                ondragstart={(e) => {
                  dragId = n.item.id;
                  // Firefox refuses to start a drag unless data is set on the DataTransfer
                  e.dataTransfer?.setData("text/plain", n.item.id);
                }}
                ondragend={() => {
                  dragId = null;
                  dropId = null;
                }}
              >
                drag_indicator</span
              >
            {/if}
            <span
              class="caret material-symbols-rounded"
              class:hidden={!n.canExpand}
              class:open={n.expanded}
              aria-hidden="true"
              onclick={(e) => {
                if (editing && n.canExpand) {
                  e.stopPropagation();
                  n.toggleExpand();
                }
              }}>{n.canExpand ? "chevron_right" : ""}</span
            >
            {#if editing}
              <input
                class="ttag"
                value={n.item.tag ?? ""}
                placeholder={n.item.slug?.short ?? "tag"}
                maxlength={12}
                spellcheck="false"
                title={n.item.code}
                aria-label={`Tag ${n.item.name || n.item.code}`}
                oninput={(e) => ontag?.(n.item.id, e.currentTarget.value)}
                onkeydown={(e) => e.stopPropagation()}
              />
              <input
                class="tedit"
                value={n.item.name}
                placeholder="Name"
                spellcheck="false"
                aria-label={`Name ${n.item.name || n.item.code}`}
                oninput={(e) => onrename?.(n.item.id, e.currentTarget.value)}
                onkeydown={(e) => e.stopPropagation()}
              />
            {:else}
              <span class="tnum" title={n.item.code}>{n.item.slug?.short ?? codeId(n.item.code)}</span>
              <span class="tname"
                >{#each boldSegments(n.item.name, n.item.slug) as seg, si (si)}{#if seg.b}<b>{seg.t}</b
                    >{:else}{seg.t}{/if}{/each}</span
              >
            {/if}
            <span class="tcount">{countOf(n) || ""}</span>
          </div>
        {/snippet}
      </RowMenu>
      {#if editing}
        <!-- edit mode: the row's add/delete actions live in this row's context menu -->
        <button
          type="button"
          class="menubtn"
          title="Device actions"
          aria-label={`Menu for ${n.item.name || n.item.code}`}
          onclick={(e) => openRowMenu(e.currentTarget.closest("[data-rowmenu]") ?? e.currentTarget)}
        >
          <span class="material-symbols-rounded" aria-hidden="true">more_vert</span>
        </button>
      {/if}
      {#if n.canExpand && n.expanded}
        <div {...tree.group} transition:slide={{ duration: 180 }}>
          {@render nodes(n.children ?? [])}
        </div>
      {/if}
    </div>
  {/each}
{/snippet}

<div {...tree.root} class="tree">
  {@render nodes(tree.children)}
</div>

<style>
  .tree {
    display: flex;
    flex-direction: column;
    outline: none;
  }
  /* keyed per-item wrapper (row + expanded subtree) — the animate:flip carrier;
     the Bits trigger renders no extra element: `.tnode` IS the context-menu trigger */
  .titem {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  /* edit mode: keyboard/touch way into the row's context menu, overlaid on the row's right edge */
  /* the shared .menubtn base lives in the layout's themeCss — only the
     catalog row's absolute placement is added here */
  .menubtn {
    position: absolute;
    top: -0.15rem;
    right: 0.1rem;
  }
  .tnode {
    display: flex;
    align-items: baseline;

    border: 1px solid var(--surface);
    gap: 0.4rem;
    text-align: left;
    background: var(--fill, transparent);
    color: var(--on-surface);
    outline: none;
    cursor: pointer;
    transition:
      background-color 180ms ease,
      color 180ms ease;
  }
  .tnode.group {
    cursor: pointer;
  }
  :root[data-theme="dark"] .tnode {
    background: var(--fill-d, transparent);
  }
  .tnode:hover {
    background: var(--marker);
    color: var(--on-marker);
  }
  :root[data-theme="dark"] .tnode:hover {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }
  .tnode.unused {
    opacity: 0.55;
  }
  .tnode.sel {
    background: var(--marker);
    color: var(--on-marker);
  }
  .tnode.sel .tnum {
    color: inherit;
  }
  :root[data-theme="dark"] .tnode.sel {
    background: var(--marker-d);
    color: var(--on-marker-d);
  }
  .caret {
    width: 0.9rem;
    flex: none;
    text-align: center;
    font-size: 1.1rem;
    color: var(--on-surface-variant, #888);
    /* one glyph (chevron_right) for every expandable row: the rotation IS the
       fold/unfold motion — points right when folded, down when open */
    transition: transform 0.18s ease;

    &.open {
      transform: rotate(90deg);
    }
  }
  .caret.hidden {
    visibility: hidden;
  }
  .tnum {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--marker);
    transition: color 180ms ease;
  }
  :root[data-theme="dark"] .tnum {
    color: var(--marker-d);
  }
  .tnode:hover .tnum {
    color: inherit;
  }
  .tname {
    flex: 1;
    font-size: 0.85rem;
  }
  .tcount {
    color: inherit;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  /* sub-category groups keep their indent, no guide line — the marker colors of
     each level carry the hierarchy */
  div[role="group"] {
    display: flex;
    flex-direction: column;
    padding-left: 1rem;
    margin-left: 0.4rem;
  }
  /* edit mode: grip handle + inline name/tag inputs, hover no longer paints the row */
  .grip {
    width: 1rem;
    flex: none;
    text-align: center;
    font-size: 1rem;
    cursor: grab;
    color: var(--on-surface-variant, #888);
  }
  .tnode.drop {
    outline: 2px dashed var(--primary, #6750a4);
    outline-offset: -2px;
  }
  /* the row being dragged reads as lifted; siblings slide into place via animate:flip */
  .tnode.dragging {
    opacity: 0.4;
  }
  .tedit {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.15rem 0.2rem;
    background: transparent;
    color: inherit;
    border: none;
    border-bottom: 1px dashed var(--outline, #888);
    border-radius: 0;
  }
  .tedit:focus {
    outline: none;
    border-bottom: 1px solid var(--primary, #6750a4);
    background: color-mix(in srgb, var(--primary, #6750a4) 8%, transparent);
  }
  /* the tag input mirrors the display tag: bold, marker-colored, left of the name */
  .ttag {
    /* tags are valid up to 12 chars (instructions.ts), and a fixed 3.6rem box hid
       26px of a 12-char tag while editing — size the box to what is typed, clamped
       so a long tag never eats the name input's space */
    box-sizing: border-box;
    field-sizing: content;
    min-width: 3.6rem;
    max-width: 7rem;
    flex: none;
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.15rem 0.2rem;
    background: transparent;
    color: var(--marker, inherit);
    border: none;
    border-bottom: 1px dashed color-mix(in srgb, var(--marker, #888) 55%, transparent);
    border-radius: 0;
    transition:
      color 180ms ease,
      background-color 180ms ease,
      border-bottom-color 180ms ease;
  }
  :root[data-theme="dark"] .ttag {
    color: var(--marker-d, inherit);
    border-bottom-color: color-mix(in srgb, var(--marker-d, #888) 55%, transparent);
  }
  .ttag:focus {
    outline: none;
    border-bottom: 1px solid var(--marker, #888);
    background: color-mix(in srgb, var(--marker, #888) 12%, transparent);
  }
  :root[data-theme="dark"] .ttag:focus {
    border-bottom-color: var(--marker-d, #888);
    background: color-mix(in srgb, var(--marker-d, #888) 12%, transparent);
  }
  .tedit::placeholder,
  .ttag::placeholder {
    color: inherit;
    opacity: 0.45;
  }
  /* editing keeps the row's own fill — hover must not repaint it solid */
  .tnode.edit:hover {
    background: var(--fill, transparent);
    color: var(--on-surface);
  }
  :root[data-theme="dark"] .tnode.edit:hover {
    background: var(--fill-d, transparent);
    color: var(--on-surface);
  }
</style>
