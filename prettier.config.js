/** @type {import("prettier").Config} */
const config = {
  printWidth: 120,
  plugins: ["prettier-plugin-svelte"],
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
};

export default config;
