<script lang="ts">
  /** A document's heading and a paragraph, in the prose style at the
   *  document's own face and size (`.doc-shell-root .solus-doc-editor`). */
  import { DOCUMENT_PREVIEW } from "./lib/font-preview-samples";
</script>

<div
  class="prose rounded-lg border border-input bg-background px-3.5 py-3 [font-family:var(--solus-document-font-family)] [--prose-size:calc(0.9375rem*var(--solus-document-font-scale,1))]"
  aria-label="Document font preview"
>
  <h3>{DOCUMENT_PREVIEW.heading}</h3>
  <p>{DOCUMENT_PREVIEW.body}</p>
</div>
