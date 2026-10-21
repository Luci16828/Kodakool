<script lang="ts">
  import RemoteDoc from "$lib/coding/RemoteDoc.svelte";

  const { data } = $props();
</script>

<!-- keyed remount per document (fresh Y.Doc + provider), like the local coding page -->
{#key `${data.account}/${data.folder}/${data.name}`}
  <RemoteDoc {data} />
{/key}
