<script lang="ts">
  // Test stand-in for the root layout: calls the SAME providers as
  // src/routes/+layout.svelte (colors + accounts + remote) so anything mounted
  // under it resolves its contexts, and wires the worker-backed Local store —
  // without the layout's fonts, theme toggle or `<svelte:head>` markup (the
  // inline head script breaks when `render()` mounts the wrapper repeatedly).
  import { provideColors } from "$lib/coding/prefs.svelte";
  import { provideAccounts } from "$lib/remote/accounts.svelte";
  import { provideRemote } from "$lib/remote/remote-cache.svelte";
  import { setLocalBackend } from "$lib/local/local-api";

  let { children } = $props();

  /** the shared color store: tests read it through the wrapper instance */
  export const prefs = provideColors();
  /** the account store (local account included): specs reach it the same way */
  export const accounts = provideAccounts();
  provideRemote();
  setLocalBackend(accounts);
</script>

{@render children()}
