<script lang="ts">
  import { Popover } from "bits-ui";
  import "material-symbols/rounded.css";

  /** The bar's Markdown cheatsheet pill + popover (shown in .md edit mode). */
  let open = $state(false);
</script>

<Popover.Root bind:open>
  <Popover.Trigger class="pill mdhelp" title="markdown syntax cheatsheet">
    <span class="material-symbols-rounded" aria-hidden="true">format_size</span>Markdown
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="cheatsheet" role="dialog" aria-label="markdown cheatsheet">
      <h3>Markdown cheatsheet</h3>
      <p class="cheatnote">
        This syntax only matters when the file is later converted to HTML or PDF (e.g. with pandoc) — plain reading
        ignores the markers.
      </p>
      <dl>
        <dt>YAML header — meta data at the very top</dt>
        <dd>
          <pre>---
title: My document
author: Me
date: 2026-02-01
tags: coding, example
---</pre>
          Not shown as text: the converter reads it as document meta data (title, author, date on the HTML/PDF title).
        </dd>
        <dt>Headers</dt>
        <dd>
          <pre># Header 1
## Header 2
### Header 3
#### Header 4
##### Header 5
###### Header 6</pre>
          →<code>&lt;h1&gt;</code>…<code>&lt;h6&gt;</code>: big bold title down to a small heading.
        </dd>
        <dt>Text</dt>
        <dd>
          <pre>*italic*  _italic_
**strong**  __strong__
***italic & strong***  ___i&s___
~~strikethrough~~</pre>
          →<em>italic</em>, <strong>bold</strong>, both, <del>strikethrough</del>.
        </dd>
        <dt>Links</dt>
        <dd>
          <pre>&lt;https://my_link.com&gt;
[MyLinkname](https://my_link.com)</pre>
          → clickable link, bare URL or with your own label.
        </dd>
        <dt>Lists</dt>
        <dd>
          <pre>* Item 1
  * Subitem 1
    * Subsubitem 1

1. Item 1
2. Item 2
3. Item 21

- [x] item done
- [ ] item todo</pre>
          → bulleted list (indent = nesting), numbered list (number items in order), task list → ☑ / ☐.
        </dd>
      </dl>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style lang="scss">
  /* Popover.Content is rendered by Bits → :global */
  :global(.cheatsheet) {
    z-index: 20;
    width: min(30rem, 90vw);
    max-height: 70vh;
    overflow: auto;
    padding: 0.7rem 0.9rem;
    background: var(--surface, white);
    border: 1px solid var(--outline, #888);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
    font-size: 0.78rem;

    h3 {
      margin: 0 0 0.3rem;
      font-size: 0.9rem;
    }

    .cheatnote {
      margin: 0 0 0.5rem;
      font-style: italic;
      color: var(--on-surface-variant, #666);
    }

    dl {
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    dt {
      font-weight: 700;
      color: var(--primary, #6750a4);
    }

    dd {
      margin: 0.15rem 0 0;
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }

    pre {
      margin: 0;
      padding: 0.35rem 0.5rem;
      background: var(--surface-variant, #eee);
      border-radius: 6px;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      line-height: 1.45;
      overflow-x: auto;
    }

    code {
      font-family: var(--font-mono, monospace);
      font-size: 0.95em;
    }
  }
</style>
