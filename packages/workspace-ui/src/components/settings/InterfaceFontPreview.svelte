<script lang="ts">
  /** What the interface font and size settings change: a card title, a line of
   *  body prose at the transcript rung, and a chrome-rung meta line. Nothing is
   *  set here — the sample inherits the root face, tracking, features, and
   *  scale exactly as every panel does. */
  import { INTERFACE_PREVIEW } from "./lib/font-preview-samples";
</script>

<div
  class="rounded-lg border border-border bg-card px-3.5 py-3 select-text"
  aria-label="Interface font preview"
>
  <p class="text-sm font-medium text-foreground">{INTERFACE_PREVIEW.title}</p>
  <p class="mt-1 text-body text-(--solus-text-primary)">
    {INTERFACE_PREVIEW.body}
  </p>
  <p class="mt-1.5 text-workspace-chrome text-(--solus-text-tertiary)">
    {INTERFACE_PREVIEW.meta}
  </p>
</div>
