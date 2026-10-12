/**
 * App-wide light/dark theme state. The initial pick is applied by the prerendered
 * script in +layout.svelte (dataset.theme + localStorage); this module only tracks
 * user toggles after that.
 */
let chosen = $state<"light" | "dark" | null>(null);

export interface Theme {
  get theme(): "light" | "dark";
  toggle(): void;
}

export function useTheme(): Theme {
  const theme = $derived(
    chosen ??
      (typeof document === "undefined"
        ? "light"
        : ((document.documentElement.dataset.theme as "light" | "dark" | undefined) ?? "light")),
  );
  function toggle(): void {
    chosen = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = chosen;
    localStorage.setItem("coding-theme", chosen);
  }
  return {
    get theme() {
      return theme;
    },
    toggle,
  };
}
