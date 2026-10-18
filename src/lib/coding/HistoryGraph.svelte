<script lang="ts">
  import { createGitgraph, templateExtend, TemplateName } from "@gitgraph/js";
  import { buildPalette } from "$lib/coding/palette";
  import { useColors } from "$lib/coding/prefs.svelte";
  import { useTheme } from "$lib/coding/theme.svelte";
  import { buildSnapshotGraph, snapshotLabel } from "$lib/coding/history-graph";
  import type { ArticleVersion } from "$lib/client/coding-db";

  /**
   * Snapshot history drawn as a git-style commit graph (`@gitgraph/js`).
   *
   * The drawing is decorative: it is `aria-hidden`, and every snapshot stays reachable
   * through the accessible list the dialog renders next to it. Clicking a commit dot
   * forwards to `onpick`, the same selection the list rows use.
   */
  let {
    versions,
    head = null,
    selected = null,
    onpick,
  }: {
    /** the article's snapshots, in stored order */
    versions: ArticleVersion[];
    /** snapshot the live document continues from */
    head?: string | null;
    /** snapshot the dialog currently points at */
    selected?: string | null;
    onpick?: (v: ArticleVersion) => void;
  } = $props();

  let host = $state<HTMLElement | null>(null);

  const prefs = useColors();
  const theme = useTheme();

  /** branch lines reuse the app's contrast-checked marker palette, so they re-tint with it */
  const BRANCH_KEYS = ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9", "g10"];
  const FONT = "'Source Sans 3 Variable', system-ui, sans-serif";

  $effect(() => {
    const outer = host;
    if (!outer) return;

    // reactive inputs: rebuilding on any of these is the whole job of this effect
    const list = versions;
    const at = head;
    const picked = selected;
    const scheme = theme.theme;
    const options = prefs.options;

    const tokens = prefs.tokens[scheme];
    const palette = buildPalette(BRANCH_KEYS, options);
    const colors = BRANCH_KEYS.map((k) => palette.get(k)?.[scheme].marker ?? tokens.primary);
    const graph = buildSnapshotGraph(list, at);

    // a fresh child per draw: gitgraph debounces its render into a setTimeout, so the
    // outgoing node is dropped from the document before that can land on a cleared host
    const canvas = document.createElement("div");
    outer.replaceChildren(canvas);

    const gitgraph = createGitgraph(canvas, {
      // no `orientation`: the default is vertical with the oldest snapshot at the bottom
      template: templateExtend(TemplateName.Metro, {
        colors,
        arrow: { color: tokens.outline, size: 6 },
        branch: {
          lineWidth: 3,
          spacing: 26,
          label: {
            color: tokens.onSurfaceVariant,
            strokeColor: tokens.outline,
            bgColor: tokens.surfaceVariant,
            font: `normal 10pt ${FONT}`,
            borderRadius: 4,
          },
        },
        commit: {
          spacing: 40,
          dot: { size: 11, font: `normal 9pt ${FONT}` },
          message: {
            displayAuthor: false,
            displayHash: false,
            color: tokens.onSurface,
            font: `normal 11pt ${FONT}`,
          },
        },
      }),
    });

    const lines = new Map<string, ReturnType<typeof gitgraph.branch>>();
    /** branch -> line color, in creation order (the column order gitgraph draws) */
    const colorOf = new Map<string, string>();
    for (const op of graph.ops) {
      if (op.create && !lines.has(op.branch)) {
        colorOf.set(op.branch, colors[colorOf.size % colors.length]);
        lines.set(
          op.branch,
          op.from !== null ? gitgraph.branch({ name: op.branch, from: op.from }) : gitgraph.branch(op.branch),
        );
      }
      const isHead = op.version.id === graph.head;
      const isPicked = op.version.id === picked;
      lines.get(op.branch)?.commit({
        subject: snapshotLabel(op.version),
        hash: op.version.id,
        // the live line is marked, the previewed snapshot gets a ring
        style:
          isHead || isPicked
            ? {
                dot: {
                  color: isHead ? tokens.primary : (colorOf.get(op.branch) ?? tokens.primary),
                  size: isPicked ? 16 : 13,
                  strokeColor: isPicked ? tokens.onSurface : undefined,
                  strokeWidth: isPicked ? 2 : undefined,
                },
              }
            : undefined,
        onClick: () => onpick?.(op.version),
      });
    }

    return () => {
      outer.replaceChildren();
    };
  });
</script>

<div class="histgraph" bind:this={host} aria-hidden="true" title="snapshot history"></div>

<style lang="scss">
  .histgraph {
    :global(svg) {
      display: block;
      max-width: 100%;
      overflow: visible;
    }
    /* commit dots are buttons for the pointer — the list beside the graph is the
       keyboard path, the drawing itself stays aria-hidden */
    :global(circle) {
      cursor: pointer;
    }
  }
</style>
