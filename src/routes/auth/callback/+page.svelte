<script lang="ts">
  import { onMount } from "svelte";
  import { resolve } from "$app/paths";
  import { goto } from "$app/navigation";
  import { useAccounts } from "$lib/remote/accounts.svelte";

  /**
   * OIDC landing page: the IdP redirects here with code+state; the pending account
   * (remembered in sessionStorage by beginOidc) is completed and the app opens.
   */
  const { data }: { data: { code: string | null; state: string | null; error: string | null } } = $props();

  const accounts = useAccounts();
  let msg = $state("Finishing sign-in…");
  let done = $state(false);

  onMount(() => {
    void (async () => {
      try {
        if (accounts === null) throw new Error("the app is not mounted");
        if (data.error) throw new Error(`the identity provider reported: ${data.error}`);
        if (data.code === null || data.state === null) throw new Error("the callback is missing code/state");
        await accounts.completeOidc(data.state, data.code);
        msg = "Signed in.";
        done = true;
        await goto(resolve("/"));
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
        done = true;
      }
    })();
  });
</script>

<svelte:head>
  <title>Signing in — Kodakool</title>
</svelte:head>

<main class="page">
  <h1>Sign in</h1>
  <p class="sub">{msg}</p>
  {#if done}
    <p><a href={resolve("/")}>← back to Kodakool</a></p>
  {/if}
</main>

<style>
  h1 {
    font-size: 1.4rem;
  }
  .sub {
    color: var(--on-surface-variant);
  }
</style>
