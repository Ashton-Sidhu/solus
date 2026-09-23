<script lang="ts">
  /** A document's heading and a paragraph, on the tokens the doc shell reads:
   *  the document face and scale for the body, the heading face for the h3,
   *  and the editor's 1.72 leading (`.doc-shell-root .solus-doc-editor`). */
  import { DOCUMENT_PREVIEW } from "./lib/font-preview-samples";
</script>

<div
  class="rounded-lg border border-border bg-card px-3.5 py-3 select-text [font-family:var(--solus-document-font-family)] [font-size:calc(1rem*var(--solus-document-font-scale,1))]"
  aria-label="Document font preview"
>
  <h3
    class="text-[1.25em] leading-[1.3] font-medium text-(--solus-text-primary) [font-family:var(--solus-document-heading-font-family)]"
  >
    {DOCUMENT_PREVIEW.heading}
  </h3>
  <p class="mt-1.5 leading-[1.72] text-(--solus-text-primary)">
    {DOCUMENT_PREVIEW.body}
  </p>
</div>
