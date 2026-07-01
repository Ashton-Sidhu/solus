<script lang="ts">
  import { CopyIcon, CheckIcon } from "phosphor-svelte";
  import { highlightCode } from "../../lib/highlight";

  interface Props {
    text: string;
    lang?: string;
  }
  let { text, lang }: Props = $props();

  // Strip a single trailing newline so the block doesn't render an empty last line.
  let code = $derived(text.replace(/\n$/, ""));
  let highlighted = $derived(highlightCode(code, lang));

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
    update();
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
    <pre use:edgeFade><code class={lang ? `language-${lang}` : ""}>{@html highlighted}</code></pre>
  </div>
</div>
