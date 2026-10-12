import { getContext, setContext } from "svelte";
import { type PaletteOptions, THEME_SOURCE, themeTokens } from "./palette";

/** localStorage key for the persisted color preferences. */
const STORE_KEY = "coding-colors";
const CONTEXT_KEY = "colors";

interface Stored {
  source: string;
  chromaAdj: number;
  toneAdj: number;
}

const stored: Stored | null = (() => {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    return {
      source: typeof v.source === "string" ? v.source : THEME_SOURCE,
      chromaAdj: typeof v.chromaAdj === "number" ? v.chromaAdj : 0,
      toneAdj: typeof v.toneAdj === "number" ? v.toneAdj : 0,
    };
  } catch {
    return null;
  }
})();

/**
 * The single source of truth for every generated color: the brand/theme source
 * (feeding the Material `themeTokens`) and the chroma/tone offsets applied to
 * every `buildPalette` marker. All color-bearing surfaces read this store, so a
 * change in one place re-tints the whole app. Instantiated once per client in the
 * root layout and shared through context.
 */
export class ColorPrefs {
  /** brand source hex for the app-wide Material theme */
  themeSource = $state(stored?.source ?? THEME_SOURCE);
  /** offset added to every fill/marker HCT chroma (0 = palette default) */
  chromaAdj = $state(stored?.chromaAdj ?? 0);
  /** offset added to every fill/marker HCT tone (0 = palette default) */
  toneAdj = $state(stored?.toneAdj ?? 0);

  /** options forwarded to `buildPalette` so every palette uses the same adjustments */
  readonly options = $derived<PaletteOptions>({ chromaAdj: this.chromaAdj, toneAdj: this.toneAdj });
  /** app-wide surface/primary tokens derived from the current source */
  readonly tokens = $derived(themeTokens(this.themeSource));

  reset(): void {
    this.themeSource = THEME_SOURCE;
    this.chromaAdj = 0;
    this.toneAdj = 0;
  }

  constructor() {
    if (typeof localStorage !== "undefined") {
      $effect(() => {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({ source: this.themeSource, chromaAdj: this.chromaAdj, toneAdj: this.toneAdj }),
        );
      });
    }
  }
}

export function provideColors(): ColorPrefs {
  const prefs = new ColorPrefs();
  setContext(CONTEXT_KEY, prefs);
  return prefs;
}

export function useColors(): ColorPrefs {
  return getContext<ColorPrefs>(CONTEXT_KEY);
}
