<script lang="ts">
  import { ContextMenu } from "bits-ui";
  import type { Snippet } from "svelte";
  import "material-symbols/rounded.css";

  /**
   * A right-click context menu over an existing row/card.
   *
   * The `trigger` snippet receives the Bits trigger props to spread onto the row's
   * own element: right-clicking anywhere inside it opens the menu AT the pointer
   * (Bits anchors a context menu at the press point, not at the element).
   */
  let {
    items,
    trigger,
    open = $bindable(false),
  }: {
    /** menu rows in display order; `danger` marks the destructive one, `sep` draws a divider above the row */
    items: { label: string; icon: string; danger?: boolean; sep?: boolean; onSelect: () => void }[];
    /** the row element the menu is anchored to (receives the trigger props) */
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
    open?: boolean;
  } = $props();
</script>

<ContextMenu.Root bind:open>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      {@render trigger({ props: { ...props, "data-rowmenu": "" } })}
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content class="ctxmenu" side="right" align="start" sideOffset={4}>
      {#each items as item (item.label)}
        {#if item.sep}<ContextMenu.Separator class="ctxsep" />{/if}
        <ContextMenu.Item class={`ctxitem ${item.danger ? "danger" : ""}`} onSelect={() => item.onSelect()}>
          <span class="material-symbols-rounded" aria-hidden="true">{item.icon}</span>
          {item.label}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

<style>
  /* Bits renders/portal-mounts the content → :global; above dialogs (41) and the switcher (60) */
  :global(.ctxmenu) {
    z-index: 70;
    min-width: 11rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.3rem;
    border: 1px solid var(--outline, #888);
    border-radius: 10px;
    background: var(--surface, white);
    color: var(--on-surface, #111);
    box-shadow: 0 6px 22px rgb(0 0 0 / 0.28);
    font-size: 0.82rem;
  }
  :global(.ctxitem) {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.35rem 0.5rem;
    border-radius: 7px;
    cursor: pointer;
  }
  :global(.ctxitem .material-symbols-rounded) {
    font-size: 1.05rem;
    color: var(--on-surface-variant, #666);
  }
  /* Bits sets data-highlighted on the keyboard/pointer-highlighted item at runtime */
  :global(.ctxitem[data-highlighted]) {
    background: var(--surface-variant, #eee);
  }
  /* group divider (Bits renders the Separator as its own element) */
  :global(.ctxsep) {
    height: 1px;
    margin: 0.2rem 0.4rem;
    background: var(--outline, #ccc);
    opacity: 0.7;
  }
  :global(.ctxitem.danger) {
    color: #b3261e;
  }
  :global(.ctxitem.danger .material-symbols-rounded) {
    color: #b3261e;
  }
</style>
