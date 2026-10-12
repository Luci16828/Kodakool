<script lang="ts">
  import "material-symbols/rounded.css";
  import { useTheme } from "./theme.svelte";

  const t = useTheme();
</script>

<button type="button" class="theme-toggle" onclick={t.toggle} title="switch color theme">
  <span class="material-symbols-rounded" aria-hidden="true">{t.theme === "dark" ? "light_mode" : "dark_mode"}</span>
</button>

<style>
  .theme-toggle {
    font: inherit;
    font-size: 0.8rem;
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--outline, #888);
    background: var(--surface, white);
    color: var(--on-surface-variant, #666);
    border-radius: 999px;
    padding: 0.15rem 0.55rem;
    cursor: pointer;
  }
  .theme-toggle:hover {
    color: var(--primary, #6750a4);
    border-color: var(--primary, #6750a4);
  }
  .theme-toggle .material-symbols-rounded {
    font-size: 1rem;
  }
</style>
