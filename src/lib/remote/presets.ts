/**
 * Pre-configured collaboration servers.
 *
 * Someone deploying the client AND a server together can bake their server URL
 * into the build — `VITE_SERVERS="https://kodakool.example,https://backup.example"
 * pnpm build` — and the connect dialog offers them as one-click sign-in targets.
 * A profile can add presets without a rebuild via `luci-server-presets` in
 * localStorage (comma-separated URLs).
 */
export interface ServerPreset {
  url: string;
}

/** Parse comma-separated server URLs: trim, require http(s) URLs, dedupe. */
export function parseServerList(raw: string | undefined | null): ServerPreset[] {
  const out: ServerPreset[] = [];
  for (const part of (raw ?? "").split(",")) {
    const url = part.trim().replace(/\/+$/, "");
    if (url === "") continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (out.some((p) => p.url === url)) continue;
    out.push({ url });
  }
  return out;
}

/** Build-time presets first, then per-profile additions, in order, deduped. */
export function serverPresets(): ServerPreset[] {
  const baked = parseServerList((import.meta.env.VITE_SERVERS as string | undefined) ?? "");
  let extra: ServerPreset[] = [];
  try {
    extra = parseServerList(typeof localStorage === "undefined" ? "" : localStorage.getItem("luci-server-presets"));
  } catch {
    /* storage unavailable (SSR / private mode) */
  }
  const seen = new Set<string>();
  return [...baked, ...extra].filter((p) => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });
}
