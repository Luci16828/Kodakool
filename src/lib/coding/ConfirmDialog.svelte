<script lang="ts">
  import { Dialog } from "bits-ui";

  /**
   * Shared destructive-action confirmation: the confirm button stays disabled
   * for `seconds` (visible countdown) so an accidental click cannot delete.
   */
  let {
    open = $bindable(false),
    title = "",
    detail = "",
    seconds = 3,
    onconfirm = () => {},
  }: {
    open?: boolean;
    title?: string;
    detail?: string;
    seconds?: number;
    onconfirm?: () => void;
  } = $props();

  let left = $state(0);

  $effect(() => {
    if (!open) return;
    left = seconds;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  });

  function confirm(): void {
    if (left > 0) return;
    open = false;
    onconfirm();
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Overlay class="dlg-overlay" />
  <Dialog.Content class="confirm" aria-label={title}>
    <h3>{title}</h3>
    {#if detail}<p class="cdetail">{detail}</p>{/if}
    <div class="cfrow">
      <button type="button" class="cfconfirm" disabled={left > 0} onclick={confirm}>
        {left > 0 ? `confirm (${left}s)` : "confirm"}
      </button>
      <button type="button" class="cfcancel" onclick={() => (open = false)}>cancel</button>
    </div>
  </Dialog.Content>
</Dialog.Root>

<style>
  /* Dialog.Content is rendered by bits — needs :global (see the shared .colorsdlg in +layout) */
  :global(.confirm) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 42;
    min-width: 17rem;
    max-width: 24rem;
    background: var(--surface, white);
    color: var(--on-surface, #111);
    border: 1px solid var(--outline, #ccc);
    border-radius: 12px;
    padding: 1rem 1.1rem;
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .cdetail {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--on-surface-variant, #666);
    overflow-wrap: anywhere;
  }
  .cfrow {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }
  .cfconfirm {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.9rem;
    border: none;
    border-radius: 8px;
    background: #b3261e;
    color: #fff;
    cursor: pointer;
  }
  .cfconfirm:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .cfcancel {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.9rem;
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    background: transparent;
    color: var(--on-surface-variant, #666);
    cursor: pointer;
  }
</style>
