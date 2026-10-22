import { describe, expect, it, vi } from "vitest";
import { parseServerList, serverPresets } from "./presets";

describe("server presets", () => {
  it("parses comma-separated URLs: trims, requires http(s), dedupes", () => {
    expect(
      parseServerList("https://a.example, http://b.example/,https://a.example ,ftp://x,garbage,https://c.example/x"),
    ).toEqual([{ url: "https://a.example" }, { url: "http://b.example" }, { url: "https://c.example/x" }]);
    expect(parseServerList("")).toEqual([]);
    expect(parseServerList(undefined)).toEqual([]);
    expect(parseServerList(null)).toEqual([]);
  });

  it("build-time VITE_SERVERS become presets (no storage in node = baked only)", () => {
    vi.stubEnv("VITE_SERVERS", "https://env.example");
    expect(serverPresets()).toContainEqual({ url: "https://env.example" });
    vi.unstubAllEnvs();
    expect(serverPresets()).toEqual([]);
  });
});
