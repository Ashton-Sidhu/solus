<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { AlertType } from "@humanspeak/svelte-markdown/extensions/alert";
  import {
    InfoIcon,
    LightbulbIcon,
    StarFourIcon,
    WarningIcon,
    XCircleIcon,
  } from "phosphor-svelte";
  import { remoteMarkdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeSpan from "./CodeSpan.svelte";
  import MarkdownListItem from "./MarkdownListItem.svelte";

  interface Props {
    text: string;
    alertType: AlertType;
  }

  let { text, alertType }: Props = $props();

  const titles: Record<AlertType, string> = {
    note: "Note",
    tip: "Tip",
    important: "Important",
    warning: "Warning",
    caution: "Caution",
  };

  const markdownRenderers = {
    codespan: CodeSpan,
    listitem: MarkdownListItem,
  };
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
    <SvelteMarkdown
      source={text}
      renderers={markdownRenderers}
      sanitizeUrl={remoteMarkdownSanitizeUrl}
    />
  </div>
</div>
