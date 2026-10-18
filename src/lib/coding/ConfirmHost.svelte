<script lang="ts">
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import type { ConfirmAsk } from "./confirm.svelte";

  /** The shared ConfirmDialog wired to a ConfirmAsk controller (one per screen). */
  let { confirm }: { confirm: ConfirmAsk } = $props();
</script>

<ConfirmDialog
  bind:open={confirm.open}
  title={confirm.title}
  detail={confirm.detail}
  onconfirm={() => confirm.fire()}
/>
