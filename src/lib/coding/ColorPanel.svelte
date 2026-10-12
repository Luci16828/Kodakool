<script lang="ts">
  import "material-symbols/rounded.css";
  import { buildPalette, onForFill } from "$lib/coding/palette";
  import { useColors } from "$lib/coding/prefs.svelte";
  import ThemeToggle from "$lib/coding/ThemeToggle.svelte";

  const prefs = useColors();

  // fixed demo codes spanning categories, so a slider move shows hue + tint variety
  const SAMPLE = ["1.1", "2.1", "3.1", "4.1", "5.1", "6.1", "7.1", "8.1"];
  const sample = $derived(buildPalette(SAMPLE, prefs.options));

  const TOKEN_KEYS = [
    "surface",
    "onSurface",
    "surfaceVariant",
    "onSurfaceVariant",
    "outline",
    "primary",
    "onPrimary",
    "primaryContainer",
    "onPrimaryContainer",
  ] as const;
  const tokenRows = $derived(
    TOKEN_KEYS.map((k) => ({ key: k, light: prefs.tokens.light[k], dark: prefs.tokens.dark[k] })),
  );
</script>

<h2>Colors</h2>
<p class="lead">Every highlight, marker and theme color in the app is derived from these controls.</p>

<div class="themrow">
  <ThemeToggle />
  <span class="themhint">light / dark theme</span>
</div>

<section class="controls">
  <label class="swatch-src" title="brand color for the whole theme">
    <input type="color" value={prefs.themeSource} oninput={(e) => (prefs.themeSource = e.currentTarget.value)} />
    <span>base color <code>{prefs.themeSource}</code></span>
  </label>

  <label class="adj" title="marker chroma (colorfulness)">
    chroma <output>{prefs.chromaAdj > 0 ? `+${prefs.chromaAdj}` : prefs.chromaAdj}</output>
    <input
      type="range"
      min={-40}
      max={40}
      step={1}
      value={prefs.chromaAdj}
      oninput={(e) => (prefs.chromaAdj = Number(e.currentTarget.value))}
    />
  </label>

  <label class="adj" title="marker tone (lightness)">
    tone <output>{prefs.toneAdj > 0 ? `+${prefs.toneAdj}` : prefs.toneAdj}</output>
    <input
      type="range"
      min={-60}
      max={25}
      step={1}
      value={prefs.toneAdj}
      oninput={(e) => (prefs.toneAdj = Number(e.currentTarget.value))}
    />
  </label>

  <button type="button" class="reset" onclick={() => prefs.reset()}>
    <span class="material-symbols-rounded" aria-hidden="true">restart_alt</span>reset all
  </button>
</section>

<section>
  <h3>Theme</h3>
  <div class="tokens">
    {#each tokenRows as t (t.key)}
      <div class="token">
        <div class="cells">
          <span style={`background:${t.light}; color:${onForFill(t.light)}`}>{t.light}</span>
          <span style={`background:${t.dark}; color:${onForFill(t.dark)}`}>{t.dark}</span>
        </div>
        <span class="key">{t.key}</span>
      </div>
    {/each}
  </div>
</section>

<section>
  <h3>Markers</h3>
  <ul class="palette">
    {#each [...sample] as [code, c] (code)}
      <li>
        <span class="chip" style={`background:${c.light.marker}; color:${c.light.on}`}>{code}</span>
        <span class="chip dark" style={`background:${c.dark.marker}; color:${c.dark.on}`}>{code}</span>
        <span class="bar" style={`background:${c.light.fill}; color:${onForFill(c.light.fill)}`}>highlighted text</span>
        <span class="bar hover" style={`background:${c.light.fillHover}; color:${onForFill(c.light.fillHover)}`}>
          on hover
        </span>
      </li>
    {/each}
  </ul>
</section>

<style>
  h2 {
    font-size: 1.15rem;
    margin: 0;
  }
  .lead {
    color: var(--on-surface-variant);
    margin: 0.25rem 0 0.8rem;
  }
  .themrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 1rem;
  }
  .themhint {
    font-size: 0.75rem;
    color: var(--on-surface-variant);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1.25rem;
    padding: 1rem;
    border: 1px solid var(--outline);
    border-radius: 8px;
  }
  .swatch-src {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .swatch-src input[type="color"] {
    width: 2.5rem;
    height: 2rem;
    border: 1px solid var(--outline);
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }
  .swatch-src code {
    color: var(--on-surface-variant);
  }
  .adj {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  .adj output {
    min-width: 2.5rem;
    font-variant-numeric: tabular-nums;
    color: var(--on-surface-variant);
  }
  .reset {
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--on-primary-container);
    background: var(--primary-container);
    border: none;
    border-radius: 99px;
    padding: 0.3rem 0.9rem;
    cursor: pointer;
  }
  .reset .material-symbols-rounded {
    font-size: 1.1rem;
  }
  h3 {
    font-size: 0.95rem;
    margin: 1.25rem 0 0.5rem;
    color: var(--on-surface-variant);
  }
  .tokens {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.5rem;
  }
  .token .cells {
    display: flex;
  }
  .token .cells span {
    flex: 1;
    padding: 0.4rem 0.55rem;
    font-size: 0.72rem;
    font-family: ui-monospace, monospace;
  }
  .token .cells span:first-child {
    border-radius: 6px 0 0 6px;
  }
  .token .cells span:last-child {
    border-radius: 0 6px 6px 0;
  }
  .token .key {
    font-size: 0.8rem;
    color: var(--on-surface-variant);
  }
  .palette {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .palette li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
    border-radius: 99px;
    font-weight: 600;
  }
  .chip.dark {
    outline: 1px solid var(--outline);
  }
  .bar {
    padding: 0.15rem 0.55rem;
    border-radius: 4px;
    border-bottom: 2px solid currentColor;
  }
</style>
