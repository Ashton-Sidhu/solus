<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    Info as InfoIcon,
    Lightbulb as LightbulbIcon,
    Sparkle as StarFourIcon,
    TriangleAlert as WarningIcon,
    CircleX as XCircleIcon,
  } from "@lucide/svelte";

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

<div class="markdown-alert markdown-alert-{alertType}" role="note">
  <div class="markdown-alert-title">
    {#if alertType === "note"}
      <InfoIcon size={16} weight="bold" aria-hidden="true" />
    {:else if alertType === "tip"}
      <LightbulbIcon size={16} weight="bold" aria-hidden="true" />
    {:else if alertType === "important"}
      <StarFourIcon size={16} weight="bold" aria-hidden="true" />
    {:else if alertType === "warning"}
      <WarningIcon size={16} weight="bold" aria-hidden="true" />
    {:else}
      <XCircleIcon size={16} weight="bold" aria-hidden="true" />
    {/if}
    <span>{titles[alertType]}</span>
  </div>
  <div class="markdown-alert-body">
    {@render content()}
  </div>
</div>
