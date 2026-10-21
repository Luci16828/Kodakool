import { defineConfig } from "vitest/config";

// The server is a standalone workspace package: its tests run in plain node
// (node:sqlite needs NODE_OPTIONS=--experimental-sqlite, set by the test script).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    expect: { requireAssertions: true },
  },
});
