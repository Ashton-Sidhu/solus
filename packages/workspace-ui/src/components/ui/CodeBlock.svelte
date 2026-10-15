<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { Copy as CopyIcon, Check as CheckIcon } from "@lucide/svelte";
  import { createIncrementalHighlight, highlightAfterPaint, loadCodeHighlighter, plainCodeLines } from "../../lib/incremental-highlight";

  interface Props {
    text: string;
    lang?: string;
    /** Actions the block's own content earns, shown in the head beside Copy.
     *  An html snippet's Render is the one caller today. */
    actions?: Snippet;
  }
  let { text, lang, actions }: Props = $props();

  // Strip a single trailing newline so the block doesn't render an empty last line.
  let code = $derived(text.replace(/\n$/, ""));

  let highlight = $state<ReturnType<typeof createIncrementalHighlight> | null>(null);
  let highlighted = $state.raw<string[]>(untrack(() => plainCodeLines(code)));

  $effect(() => {
    const language = lang;
    let active = true;
    highlight = null;
    if (language) {
      void loadCodeHighlighter(language).then((loaded) => {
        if (active && loaded) highlight = createIncrementalHighlight(loaded.highlighter, loaded.language);
      }).catch(() => { /* Plain escaped code remains readable if loading fails. */ });
    }
    return () => { active = false; };
  });

  // Each completed line keeps its DOM. Async grammar loading and source changes
  // invalidate only this block; theme switches use the token CSS variables.
  // The first colours wait for paint; a block that streams then stays live.
  let hasColours = false;
  $effect(() => {
    const next = highlight;
    const source = code;
    if (!next) {
      hasColours = false;
      highlighted = plainCodeLines(source);
      return;
    }
    if (hasColours) {
      highlighted = next(source);
      return;
    }
    return highlightAfterPaint(() => {
      highlighted = next(source);
      hasColours = true;
    });
  });

  let copied = $state(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {}
  }

  // Toggle edge-fade overlays as the code scrolls horizontally. Lives as an
  // action (no $effect) so the listener is scoped to the scroll element.
  function edgeFade(node: HTMLElement) {
    const update = () => {
      node.classList.toggle("fade-l", node.scrollLeft > 1);
      node.classList.toggle(
        "fade-r",
        node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      );
    };
    // No read at mount: it forced a layout for each block as a transcript
    // mounted. The observer's first report comes after the frame's layout and
    // before it paints, so the fades are right in the first frame.
    node.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return {
      destroy() {
        node.removeEventListener("scroll", update);
        ro.disconnect();
      },
    };
  }
</script>

<div class="solus-code-block group/code">
  <div class="solus-code-head">
    <span class="solus-code-lang">{lang || "text"}</span>
    {@render actions?.()}
    <button
      onclick={handleCopy}
      class="solus-code-copy"
      class:is-copied={copied}
      title="Copy code"
    >
      <span class="icon-swap">
        <CopyIcon
          size={11}
          style="position:absolute;transition:opacity 0.2s cubic-bezier(0.2,0,0,1),transform 0.2s cubic-bezier(0.2,0,0,1),filter 0.2s cubic-bezier(0.2,0,0,1);opacity:{copied
            ? 0
            : 1};transform:scale({copied ? 0.25 : 1});filter:blur({copied
            ? '0.25rem'
            : '0'})"
        />
        <CheckIcon
          size={11}
          style="transition:opacity 0.2s cubic-bezier(0.2,0,0,1),transform 0.2s cubic-bezier(0.2,0,0,1),filter 0.2s cubic-bezier(0.2,0,0,1);opacity:{copied
            ? 1
            : 0};transform:scale({copied ? 1 : 0.25});filter:blur({copied
            ? '0'
            : '0.25rem'})"
        />
      </span>
      <span class="solus-code-copy-label">{copied ? "Copied" : "Copy"}</span>
    </button>
  </div>
  <div class="solus-code-body">
    <pre use:edgeFade><code class="shiki {lang ? `language-${lang}` : ''}">{#each highlighted as line, index (index)}<span class="code-line">{@html line}</span>{#if index < highlighted.length - 1}{"\n"}{/if}{/each}</code></pre>
  </div>
</div>
