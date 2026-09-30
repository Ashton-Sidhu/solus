<script lang="ts">
  import { jumpWithinReply } from "./lib/markdown-extensions";

  /** A `[^id]` reference. It moves to its note inside the same reply. */
  let { id }: { id: string } = $props();
</script>

<sup
  ><button
    type="button"
    class="inline-flex min-w-4 cursor-pointer items-center justify-center rounded-sm px-0.5 text-[0.6875rem] font-semibold text-(--solus-text-secondary) hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] focus-visible:outline-2 focus-visible:outline-ring"
    data-footnote-ref={id}
    aria-label="Footnote {id}"
    onclick={(event) => jumpWithinReply(event.currentTarget, `[data-footnote="${CSS.escape(id)}"]`)}
    >{id}</button
  ></sup
>
