<script lang="ts">
  // Test stand-in for the root layout's color provider: calls `provideColors()` exactly
  // like src/routes/+layout.svelte so anything mounted under it resolves `useColors()`
  // from context, but without the layout's fonts, theme toggle or `<svelte:head>` markup
  // (the inline head script breaks when `render()` mounts the wrapper repeatedly).
  import { provideColors } from "$lib/coding/prefs.svelte";

  let { children } = $props();

  /** the shared color store: tests read it through the wrapper instance */
  export const prefs = provideColors();
</script>

{@render children()}
