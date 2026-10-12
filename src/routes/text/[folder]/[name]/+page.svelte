<script lang="ts">
  import CodingDoc from "./CodingDoc.svelte";

  const { data } = $props();
</script>

<!-- SvelteKit reuses this component between documents on the same route; the key
     forces a full remount (fresh editor, RxDB subscription, catalog) per document -->
{#key `${data.folder}/${data.name}`}
  <CodingDoc {data} />
{/key}
