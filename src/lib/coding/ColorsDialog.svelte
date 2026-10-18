<script lang="ts">
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import ColorPanel from "./ColorPanel.svelte";

  /**
   * The app-wide colors customization popup (Bits Dialog): wraps the screen it
   * belongs to, the trigger pill renders through the `children` snippet inside
   * the Dialog.Root, the panel itself is the shared ColorPanel.
   */
  let {
    open = $bindable(false),
    children,
  }: {
    open?: boolean;
    children: import("svelte").Snippet;
  } = $props();
</script>

<Dialog.Root bind:open>
  {@render children()}
  <Dialog.Overlay class="dlg-overlay" />
  <Dialog.Content class="colorsdlg" aria-label="colors">
    <Dialog.Close class="dlgclose" aria-label="close colors">
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </Dialog.Close>
    <ColorPanel />
  </Dialog.Content>
</Dialog.Root>
