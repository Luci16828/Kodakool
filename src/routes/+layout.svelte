<script lang="ts">
  import { onMount } from "svelte";
  import "@fontsource-variable/source-sans-3";
  import "@fontsource-variable/source-serif-4";
  import "material-symbols/rounded.css";
  import favicon from "$lib/assets/favicon.svg";
  import { provideColors } from "$lib/coding/prefs.svelte";
  import { seedExampleProject } from "$lib/client/examples";

  let { children } = $props();

  // the single color source for the whole app (theme + every marker palette)
  const prefs = provideColors();

  // first visit: seed the bundled example project into the local store
  onMount(() => {
    void seedExampleProject();
  });
  const vars = (t: Record<string, string>) =>
    [
      `--surface: ${t.surface}`,
      `--on-surface: ${t.onSurface}`,
      `--surface-variant: ${t.surfaceVariant}`,
      `--on-surface-variant: ${t.onSurfaceVariant}`,
      `--outline: ${t.outline}`,
      `--primary: ${t.primary}`,
      `--on-primary: ${t.onPrimary}`,
      `--primary-container: ${t.primaryContainer}`,
      `--on-primary-container: ${t.onPrimaryContainer}`,
    ].join("; ");
  const themeCss = $derived(
    [
      `:root { color-scheme: light; --font-sans: 'Source Sans 3 Variable', system-ui, sans-serif; --font-serif: 'Source Serif 4 Variable', Georgia, serif; ${vars(prefs.tokens.light)} }`,
      `:root[data-theme='dark'] { color-scheme: dark; ${vars(prefs.tokens.dark)} }`,
      `body { margin: 0; background: var(--surface); color: var(--on-surface); font-family: var(--font-sans); transition: background 0.2s, color 0.2s; }`,
      `a { color: var(--primary); }`,
      /* shared UI primitives — global so headless-component-rendered elements
         (Bits Dialog pills/overlay/content) are styled too */
      `.pill { font: inherit; font-size: 0.8rem; display: inline-flex; align-items: center; flex: 0 0 auto; white-space: nowrap; gap: 0.35rem; color: var(--on-surface-variant, #666); background: var(--surface, white); padding: 0.15rem 0.7rem; border: 1px solid var(--outline, #888); border-radius: 999px; cursor: pointer; }`,
      `.pill:hover { color: var(--primary, #6750a4); border-color: var(--primary, #6750a4); }`,
      `.pill .material-symbols-rounded { font-size: 1rem; }`,
      `.dlg-overlay { position: fixed; inset: 0; z-index: 40; background: black; opacity: 0.35; }`,
      `.colorsdlg { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 41; width: min(34rem, 92vw); max-height: 84vh; overflow: auto; padding: 1.25rem 1.4rem; border: 1px solid var(--outline, #888); border-radius: 12px; background: var(--surface, white); color: var(--on-surface, #1c1b1f); }`,
      `.dlgclose { position: absolute; top: 0.6rem; right: 0.6rem; font: inherit; display: inline-flex; border: none; background: none; padding: 0.15rem; cursor: pointer; color: var(--on-surface-variant, #666); }`,
      `.dlgclose .material-symbols-rounded { font-size: 1.2rem; }`,
      `.dlgclose:hover { color: var(--primary, #6750a4); }`,
      /* shared screen primitives — global so every screen (dashboard, project page,
         coding page) styles the same buttons/chips/delete icons from one place */
      `.page { max-width: 44rem; margin: 2rem auto; padding: 0 1rem; }`,
      `.actions { margin-top: 1rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }`,
      `.go { font: inherit; display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.35rem 0.9rem; border-radius: 99px; border: 1px solid var(--primary, #6750a4); background: var(--primary, #6750a4); color: white; cursor: pointer; }`,
      `.go .material-symbols-rounded { font-size: 1.1rem; }`,
      `.go:disabled { opacity: 0.6; cursor: default; }`,
      `.export { font: inherit; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.3rem; color: var(--on-surface-variant); background: var(--surface-variant); border: none; border-radius: 99px; padding: 0.1rem 0.6rem; cursor: pointer; }`,
      `.export .material-symbols-rounded { font-size: 1rem; }`,
      `.export:hover { filter: brightness(1.1); }`,
      `.delproj { font: inherit; font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.3rem; color: #b3261e; background: none; border: 1px solid #b3261e; border-radius: 99px; padding: 0.1rem 0.6rem; cursor: pointer; }`,
      `.delproj .material-symbols-rounded { font-size: 1rem; }`,
      `.delproj:hover { background: #b3261e; color: white; }`,
      `.fdel { font: inherit; display: inline-flex; align-items: center; border: none; background: none; padding: 0.1rem; cursor: pointer; color: var(--on-surface-variant, #888); }`,
      `.fdel .material-symbols-rounded { font-size: 1rem; }`,
      `.fdel:hover { color: #b3261e; }`,
      `.chip { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 99px; background: var(--surface-variant); color: var(--on-surface-variant); }`,
      `.chip.versions { background: var(--primary-container); color: var(--on-primary-container); }`,
      `.chip.ex { background: var(--primary); color: var(--on-primary); }`,
    ].join("\n"),
  );
</script>

<svelte:head>
  <link rel="icon" href={favicon} />
  <!-- prerendered theme pick, applied before first paint -->
  <script>
    const params = new URLSearchParams(location.search);
    document.documentElement.dataset.theme = params.get("theme") ?? localStorage.getItem("coding-theme") ?? "light";
  </script>
  {@html `<style>\n${themeCss}\n</style>`}
</svelte:head>

{@render children()}
