<script lang="ts">
  import "material-symbols/rounded.css";
  import type { EntryPopupCtl } from "./entry-popup.svelte";
  import type { CodeEntry } from "./types";

  /**
   * The entry detail popup: anchored above the hovered label chip, carrying the
   * device's full name, the note editor and the delete button. The state +
   * grace-close logic lives in the EntryPopupCtl the page passes in.
   */
  let {
    ctl,
    entry,
    fullName,
    tag,
    onnote,
    ondelete,
  }: {
    ctl: EntryPopupCtl;
    entry: CodeEntry | undefined;
    fullName: string;
    tag: { marker: string; markerD: string; on: string; onD: string };
    onnote: (value: string) => void;
    ondelete: () => void;
  } = $props();
</script>

{#if ctl.popup !== null && entry !== undefined}
  <div
    class="tpopup"
    style={`left: ${ctl.popup.x}px; bottom: ${ctl.popup.y}px; --tag:${tag.marker}; --tag-d:${tag.markerD}; --tag-on:${tag.on}; --tag-on-d:${tag.onD}`}
    role="dialog"
    tabindex={-1}
    aria-label="code entry"
    onmouseenter={() => ctl.enter()}
    onmouseleave={() => ctl.leave()}
  >
    <span class="tname">{fullName}</span>
    <textarea class="tnote" rows={2} placeholder="note" value={ctl.note} oninput={(e) => onnote(e.currentTarget.value)}
    ></textarea>
    <button type="button" class="del" onclick={ondelete}> delete </button>
  </div>
{/if}

<style lang="scss">
  .tpopup {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 16rem;
    max-width: 22rem;
    padding: 0.5rem 0.6rem 0.6rem;
    background: var(--tag, #888);
    color: var(--tag-on, #fff);
    border: 1px solid var(--tag, #888);
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    box-shadow: 0 -6px 18px rgb(0 0 0 / 0.18);

    .tname {
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--tag-on, #fff);
    }

    .tnote {
      font: inherit;
      font-size: 0.82rem;
      padding: 0.3rem 0.4rem;
      background: var(--surface, #fff);
      border: 1px solid var(--tag-on, #ccc);
      border-radius: 6px;
      resize: vertical;
    }

    .del {
      align-self: flex-start;
      font: inherit;
      font-size: 0.8rem;
      color: var(--tag-on, #fff);
      border: 1px solid var(--tag-on, #ffffff66);
      border-radius: 999px;
      background: transparent;
      padding: 0.1rem 0.6rem;
      cursor: pointer;
    }
  }
</style>
