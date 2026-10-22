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
  // Pre-bundle the deps that join the module graph only MID RUN (the SharedWorker's
  // server stack on the first worker import, the Yjs room stack on the first room,
  // unpdf on the first PDF). Vite scans only the entries at startup, so discovering
  // them later triggers "optimized dependencies changed. reloading" — which, under
  // `pnpm test:coverage`, reloads pages mid-suite and fails the tests they are in.
  // hono/jose/openid-client/sql.js are declared at the ROOT too (server keeps its
  // own copy for the node server): the SharedWorker runs the server graph in the
  // browser, so these are app dependencies, and pnpm's strict layout requires the
  // root declaration for Vite to pre-bundle their bare specifiers.
  // y-protocols has no root export, so only its deep imports are listed.
  optimizeDeps: {
    include: [
      "yjs",
      "y-protocols/sync",
      "y-protocols/awareness",
      "lib0",
      "lib0/*",
      "unpdf",
      "hono",
      "jose",
      "jose/*",
      "openid-client",
      "sql.js",
    ],
  },
  // the Local account's in-worker server lives in the `server` workspace package:
  // vite must be allowed to serve it into the module worker (dev fs allow-list)
  server: { fs: { allow: ["."] } },
  test: {
    expect: { requireAssertions: true },
    // the SharedWorker keeps a permanent connection per page: flushing v8 coverage
    // on browser teardown needs more than the 10s default, and a timed-out close
    // silently drops the coverage data of every browser test file
    teardownTimeout: 30000,
    // `pnpm test:coverage` — app-code coverage only: specs, fixtures and the
    // bundled example assets are not the measured code. The SvelteKit load
    // functions and the app shell are routing glue: specs render pages directly
    // (ColorProvider.svelte replaces +layout.svelte as the render wrapper), so
    // they never execute under test.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/routes/**"],
      exclude: [
        "src/lib/vitest-examples/**",
        "src/lib/assets/**",
        "**/*.spec.ts",
        "**/*.test.ts",
        "src/routes/**/+layout.ts",
        "src/routes/**/+page.ts",
        "src/routes/+layout.svelte",
      ],
      thresholds: {
        // floor set from the measured baseline (pnpm test:coverage), raised only by design
        // cutover re-baseline (server/worker architecture): 83.7/70.4/85.1/86.0
        lines: 86,
        functions: 85,
        statements: 83,
        branches: 70,
      },
    },
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
            // the coding page is a desktop layout: the 414px default viewport
            // squeezed the bar into overflow, so clicks landed on shifted pills
            viewport: { width: 1280, height: 900 },
          },
          // every client test file drives the worker store through IndexedDB;
          // one file at a time keeps the debounced full-image export a
          // single-writer exchange (parallel files would overwrite each other's image)
          fileParallelism: false,
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
