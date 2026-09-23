<script lang="ts">
  /** Code on the diff's own tokens — the code face, the code size, and the
   *  1.6 leading `Diff.svelte` derives from it. The sample keeps `0O` and
   *  `1lI` on one line, which is where a monospace face earns its keep. */
  import { CODE_PREVIEW } from "./lib/font-preview-samples";
</script>

<pre
  class="overflow-x-auto rounded-lg bg-(--solus-code-tint) px-3.5 py-3 leading-[1.6] whitespace-pre text-(--solus-text-primary) select-text [font-family:var(--solus-code-font-family)] [font-size:var(--solus-code-font-size)]"
  aria-label="Code font preview">{CODE_PREVIEW}</pre>
