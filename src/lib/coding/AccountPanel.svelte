<script lang="ts">
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import "material-symbols/rounded.css";
  import type { ConfirmAsk } from "$lib/coding/confirm.svelte";
  import { serverHost, useAccounts } from "$lib/remote/accounts.svelte";
  import { useRemote } from "$lib/remote/remote-cache.svelte";

  /**
   * The account selector at the bottom of the document-tree sidebar: the virtual
   * Local account (this browser's RxDB store) plus every connected collaboration
   * server account. "Connect server" opens the add dialog — username/password
   * (login or signup) or OIDC (issuer + client id, the browser redirects to the
   * identity provider and lands on /auth/callback). Removing an account signs out
   * and drops its session; local data is never touched.
   */
  let { confirm }: { confirm: ConfirmAsk } = $props();

  // null when the component is mounted outside the app layout (unit specs): the panel renders nothing
  const accounts = useAccounts();
  const remote = useRemote();

  let open = $state(false);
  let busy = $state(false);
  let msg = $state("");

  let label = $state("");
  let serverUrl = $state("");
  let mode = $state<"password" | "oidc">("password");
  let email = $state("");
  let password = $state("");
  let signup = $state(false);
  let iss = $state("");
  let clientId = $state("");

  const canConnect = $derived(
    serverUrl.trim() !== "" &&
      (mode === "password" ? email.trim() !== "" && password !== "" : iss.trim() !== "" && clientId.trim() !== ""),
  );

  async function connect(): Promise<void> {
    if (!accounts) return;
    busy = true;
    msg = "";
    try {
      const url = serverUrl.trim().replace(/\/+$/, "");
      if (mode === "password") {
        await accounts.addPassword(label, url, email.trim(), password, signup);
        open = false;
        email = "";
        password = "";
      } else {
        // the browser leaves for the IdP; the callback route finishes the sign-in
        await accounts.beginOidc(label, url, iss.trim(), clientId.trim());
      }
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** pull every account's project list on mount; renew expired sessions once */
  async function refreshAll(): Promise<void> {
    if (!accounts || !remote) return;
    for (const a of accounts.accounts) {
      const cache = remote.cache(a.id);
      if (a.token === null) await accounts.refresh(a.id);
      const token = accounts.tokenOf(a.id);
      if (token === null) continue;
      await cache.refreshProjects(accounts.api(a), token);
      if (cache.error !== "" && (await accounts.refresh(a.id))) {
        await cache.refreshProjects(accounts.api(a), accounts.tokenOf(a.id) ?? "");
      }
    }
  }

  onMount(() => {
    void refreshAll();
  });

  function askRemove(id: string, name: string): void {
    confirm.ask(
      `Remove account "${name}"?`,
      "Its session is signed out; nothing on the server or in this browser is deleted.",
      () => accounts?.remove(id),
    );
  }
</script>

<Dialog.Root bind:open>
  {#if accounts && remote}
    <div class="acct">
      <div class="accthead">
        <span class="acctcap">accounts</span>
        <Dialog.Trigger
          class="menubtn acctadd"
          title="Connect a collaboration server account"
          aria-label="Connect server"
        >
          <span class="material-symbols-rounded" aria-hidden="true">person_add</span>
        </Dialog.Trigger>
      </div>
      <ul class="acctlist">
        <li class="acctrow on" title="This browser's local database — always available">
          <span class="material-symbols-rounded" aria-hidden="true">inventory_2</span>
          <span class="acctmeta"><span class="acctname">Local</span><span class="acctsub">this browser</span></span>
        </li>
        {#each accounts.accounts as a (a.id)}
          <li class="acctrow">
            <span class="material-symbols-rounded" aria-hidden="true"
              >{a.token === null ? "cloud_off" : "cloud_done"}</span
            >
            <span class="acctmeta">
              <span class="acctname">{a.label}</span>
              <span class="acctsub">{a.user?.name ?? "signed out"} · {serverHost(a.serverUrl)}</span>
            </span>
            <button
              type="button"
              class="menubtn"
              title="Remove account"
              aria-label={`Remove account ${a.label}`}
              onclick={() => askRemove(a.id, a.label)}
            >
              <span class="material-symbols-rounded" aria-hidden="true">delete</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <Dialog.Overlay class="dlg-overlay" />
  <Dialog.Content class="accdlg" aria-label="Connect server">
    <h2>Connect server</h2>
    <label class="accfld">
      <span>Name</span>
      <input type="text" placeholder="my server" aria-label="Account label" bind:value={label} spellcheck="false" />
    </label>
    <label class="accfld">
      <span>Server URL</span>
      <input
        type="text"
        placeholder="https://kodakool.example"
        aria-label="Server URL"
        bind:value={serverUrl}
        spellcheck="false"
      />
    </label>
    <div class="acctabs" role="tablist" aria-label="Sign-in method">
      <button
        type="button"
        role="tab"
        class={`tabbtn ${mode === "password" ? "on" : ""}`}
        aria-selected={mode === "password"}
        aria-label="Username and password"
        onclick={() => (mode = "password")}
      >
        Password
      </button>
      <button
        type="button"
        role="tab"
        class={`tabbtn ${mode === "oidc" ? "on" : ""}`}
        aria-selected={mode === "oidc"}
        aria-label="OIDC sign-in"
        onclick={() => (mode = "oidc")}
      >
        OIDC
      </button>
    </div>
    {#if mode === "password"}
      <label class="accfld">
        <span>Email</span>
        <input type="email" aria-label="Email" bind:value={email} spellcheck="false" autocomplete="username" />
      </label>
      <label class="accfld">
        <span>Password</span>
        <input type="password" aria-label="Password" bind:value={password} autocomplete="current-password" />
      </label>
      <label class="accchk">
        <input type="checkbox" aria-label="Create the account first" bind:checked={signup} />
        create the account first (signup)
      </label>
    {:else}
      <label class="accfld">
        <span>Issuer (OIDC)</span>
        <input
          type="text"
          placeholder="https://id.example/realms/main"
          aria-label="OIDC issuer"
          bind:value={iss}
          spellcheck="false"
        />
      </label>
      <label class="accfld">
        <span>Client ID</span>
        <input
          type="text"
          placeholder="kodakool"
          aria-label="OIDC client id"
          bind:value={clientId}
          spellcheck="false"
        />
      </label>
      <p class="acchint">The browser signs in at the identity provider and returns here.</p>
    {/if}
    {#if msg}<p class="accmsg">{msg}</p>{/if}
    <div class="actions">
      <button type="button" class="go" disabled={busy || !canConnect} onclick={() => void connect()}>
        <span class="material-symbols-rounded" aria-hidden="true">login</span>
        {mode === "oidc" ? "Sign in with OIDC" : "Sign in"}
      </button>
      <Dialog.Close class="pill">Cancel</Dialog.Close>
    </div>
    <Dialog.Close class="dlgclose" aria-label="Close">
      <span class="material-symbols-rounded" aria-hidden="true">close</span>
    </Dialog.Close>
  </Dialog.Content>
</Dialog.Root>

<style lang="scss">
  /* pinned to the sidebar bottom: the tree scrolls above it */
  .acct {
    border-top: 1px solid var(--outline, #ccc);
    padding-top: 0.35rem;
    margin-top: 0.25rem;
  }
  .accthead {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .acctcap {
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--on-surface-variant, #666);
  }
  .acctadd {
    margin-left: auto;
  }
  .acctlist {
    list-style: none;
    margin: 0.15rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .acctrow {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.25rem;
    border-radius: 6px;
    font-size: 0.78rem;
    color: var(--on-surface-variant, #666);

    &.on {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
    }

    .material-symbols-rounded {
      font-size: 1.05rem;
      flex: 0 0 auto;
    }
  }
  .acctmeta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .acctname {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .acctsub {
    font-size: 0.66rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* the connect dialog */
  :global(.accdlg) {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 41;
    box-sizing: border-box;
    width: min(26rem, 92vw);
    padding: 1.2rem 1.4rem;
    border: 1px solid var(--outline, #888);
    border-radius: 12px;
    background: var(--surface, white);
    color: var(--on-surface, #1c1b1f);

    h2 {
      margin: 0 0 0.7rem;
      font-size: 1.05rem;
    }
  }
  .accfld {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
    font-size: 0.8rem;

    span {
      flex: 0 0 6.2rem;
      color: var(--on-surface-variant, #666);
    }

    input {
      font: inherit;
      flex: 1;
      min-width: 0;
      padding: 0.3rem 0.5rem;
      border: 1px solid var(--outline, #888);
      border-radius: 8px;
      background: var(--surface, white);
      color: var(--on-surface, #111);
    }
  }
  .accchk {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    color: var(--on-surface-variant, #666);
  }
  .acctabs {
    display: flex;
    gap: 0;
    margin: 0 0 0.7rem;
  }
  .tabbtn {
    font: inherit;
    font-size: 0.78rem;
    padding: 0.2rem 0.8rem;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    cursor: pointer;

    &:first-child {
      border-radius: 999px 0 0 999px;
    }

    &:last-child {
      border-radius: 0 999px 999px 0;
      border-left: none;
    }

    &.on {
      background: var(--primary-container, #e8def8);
      color: var(--on-primary-container, #21005d);
      font-weight: 700;
    }
  }
  .acchint {
    margin: 0 0 0.5rem;
    font-size: 0.72rem;
    color: var(--on-surface-variant, #666);
  }
  .accmsg {
    margin: 0 0 0.5rem;
    font-size: 0.75rem;
    color: #b3261e;
  }
</style>
