<script lang="ts">
  import { LOCAL_ACCOUNT_ID } from "$lib/remote/accounts.svelte";
  import RemoteDoc from "$lib/coding/RemoteDoc.svelte";

  const { data }: { data: { folder: string; name: string } } = $props();
</script>

<!-- The Local account IS the in-worker server now: the local coding page is the SAME
     RemoteDoc the remote accounts use, pointed at the worker (account "local").
     The key forces a full remount (fresh Y.Doc + provider) per document. -->
{#key `${data.folder}/${data.name}`}
  <RemoteDoc data={{ account: LOCAL_ACCOUNT_ID, folder: data.folder, name: data.name }} />
{/key}
