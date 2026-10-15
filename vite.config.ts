import process from "node:process";
import { mdsvex } from "mdsvex";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// GitHub Pages serves a project site under /<repo>/, so the app must know its base path.
// The Pages workflow exports BASE_PATH="/<repo>"; dev, preview, check and tests run at "/".
const basePath = (process.env.BASE_PATH ?? "") as "" | `/${string}`;

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
      },

      // Static export (GitHub Pages): the app is local-first (RxDB in the browser, see
      // src/lib/client/coding-db.ts), so the build is a plain static site — no server runtime.
      // `404.html` is the GitHub Pages SPA fallback: deep links like /text/<folder>/<name>
      // are not prerenderable (their data lives in the browser), so GitHub serves this shell
      // and the client router takes over.
      adapter: adapter({ fallback: "404.html" }),
      paths: {
        base: process.argv.includes("dev") ? "" : basePath,
      },
      preprocess: [vitePreprocess(), mdsvex({ extensions: [".svx", ".md"] })],
      extensions: [".svelte", ".svx", ".md"],
    }),
  ],
  // material-color-utilities ships ESM with extensionless internal imports;
  // it must be bundled rather than externalized (build/prerender + vitest).
  ssr: { noExternal: ["@material/material-color-utilities"] },
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "client",
          browser: {
            enabled: true,
            provider: playwright(),
            // BROWSER=firefox pnpm test → run the client suite in Firefox
            instances: [{ browser: (process.env.BROWSER ?? "chromium") as "chromium" | "firefox", headless: true }],
          },
          // every client test file shares one Dexie/RxDB store in parallel:
          // the default 1s `expect.poll` timeout is too tight under that load
          expect: { requireAssertions: true, poll: { timeout: 5000 } },
          include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
          exclude: ["src/lib/server/**"],
        },
      },

      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
    ],
  },
});
