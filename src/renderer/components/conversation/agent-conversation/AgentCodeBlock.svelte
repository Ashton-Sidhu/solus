<script lang="ts">
  /**
   * A fenced block inside an exchange card. Deliberately not the transcript's
   * CodeBlock: no syntax highlighting, because colour in this component means
   * agent identity and a second colour system would fight it; and no per-block
   * copy chrome, because the card is a conversation, not a log viewer.
   *
   * Both axes scroll rather than reflow — a wrapped code line is worse than a
   * scrollbar, and twelve rows is as tall as a quoted block gets before the
   * card stops being readable at a glance.
   */
  interface Props {
    text: string;
    lang?: string;
  }
  let { text }: Props = $props();
</script>

<pre
  class="mt-2.5 mb-0 px-3 py-2.5 rounded-lg overflow-auto max-h-[15.9375rem] font-mono text-sm leading-[1.7] whitespace-pre bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"><code
    >{text}</code
  ></pre>
