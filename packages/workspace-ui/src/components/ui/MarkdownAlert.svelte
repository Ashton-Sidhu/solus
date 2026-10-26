<script lang="ts">
  import type { Snippet } from 'svelte';

  type AlertType = "note" | "tip" | "important" | "warning" | "caution";

  interface Props {
    content: Snippet;
    alertType: AlertType;
  }

  let { alertType, content }: Props = $props();

  const titles = {
    note: "Note",
    tip: "Tip",
    important: "Important",
    warning: "Warning",
    caution: "Caution",
  } satisfies Record<AlertType, string>;
</script>

<!-- A GitHub alert (`> [!NOTE]`): the prose callout band, labelled by its
     kind. `dir="auto"` takes the direction of the body: the browser skips the
     text in `bdi`, so the English label does not set it. -->
<div class="prose-callout" data-kind={alertType} role="note" dir="auto">
  <bdi class="prose-callout-label">{titles[alertType]}</bdi>
  <div class="prose-callout-body">
    {@render content()}
  </div>
</div>
