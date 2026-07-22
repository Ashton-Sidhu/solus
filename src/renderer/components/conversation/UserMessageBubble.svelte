<script lang="ts">
  import { fly } from "svelte/transition";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import { FileTextIcon, ImageIcon, FileCodeIcon, FileIcon, XIcon, LightningIcon } from "phosphor-svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { requestFilePreview } from "../../lib/filePreview";
  import { portal } from "../portal";
  import { formatMessageTime } from "../../lib/sessionUtils";
  import type { Message } from "../../../shared/types";
  import type { Component } from "svelte";

  const markdownRenderers = { link: MarkdownLink, codespan: CodeSpan, text: MarkdownText };

  interface Props {
    message?: Message;
    content?: string;
    attachments?: Message['attachments'];
    queued?: boolean;
    queueId?: string;
    onCancel?: (queueId: string) => void;
    skipMotion?: boolean;
  }
  let { message, content, attachments, queued = false, queueId, onCancel, skipMotion = false }: Props = $props();

  const theme = getSettingsContext();
  const session = getWorkspaceContext();

  const text = $derived(content ?? message?.content ?? "");
  const allAttachments = $derived(attachments ?? message?.attachments);
  const imageAttachments = $derived(
    allAttachments?.filter((a) => a.dataUrl && a.type !== 'file') ?? [],
  );
  const fileAttachments = $derived(
    allAttachments?.filter((a) => !a.dataUrl || a.type === 'file') ?? [],
  );
  let previewSrc = $state<string | null>(null);

  const FILE_ICON_COMPONENTS: Record<string, Component> = {
    'image/png': ImageIcon,
    'image/jpeg': ImageIcon,
    'image/gif': ImageIcon,
    'image/webp': ImageIcon,
    'image/svg+xml': ImageIcon,
    'text/plain': FileTextIcon,
    'text/markdown': FileTextIcon,
    'application/json': FileCodeIcon,
    'text/yaml': FileCodeIcon,
    'text/toml': FileCodeIcon,
  }

  // Only register the window listener while a preview is open — avoids
  // hundreds of global keydown handlers across all user messages and tabs.
  $effect(() => {
    if (!previewSrc) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") previewSrc = null;
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

</script>

{#snippet bubbleBody()}
  {#if imageAttachments.length > 0}
    <div class="flex gap-1.5 flex-wrap justify-end" style="max-width:85%">
      {#each imageAttachments as a, i (i)}
        <button
          onclick={() => (previewSrc = a.dataUrl!)}
          style="padding:0;border:none;background:none;cursor:zoom-in;border-radius:0.5rem"
        >
          <img
            src={a.dataUrl}
            alt={a.name}
            class="border border-(--solus-surface-secondary)"
            style="width:4rem;height:4rem;border-radius:0.5rem;object-fit:cover"
          />
        </button>
      {/each}
    </div>
  {/if}

  {#if fileAttachments.length > 0}
    <div class="flex gap-1.5 flex-wrap justify-end" style="max-width:85%">
      {#each fileAttachments as a, i (i)}
        {@const IconComponent = FILE_ICON_COMPONENTS[a.mimeType || ''] || FileIcon}
        <button
          type="button"
          onclick={() => requestFilePreview({
            path: a.path,
            tabId: session.focusedChatTabId ?? session.activeTabId,
          })}
          class="flex items-center gap-1.5 bg-(--solus-surface-primary) border border-(--solus-surface-secondary)"
          style="border-radius:0.625rem;padding:0.25rem 0.5rem;max-width:11.25rem"
        >
          <span class="flex-shrink-0 text-(--solus-text-tertiary)">
            <IconComponent size={13} />
          </span>
          <span class="text-[0.6875rem] font-medium truncate text-(--solus-text-secondary)" style="min-width:0">
            {a.name}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if text}
    <div class="relative flex items-end gap-2 max-w-[85%]">
      <div class="relative group/queued min-w-0">
        <div
          class="overflow-hidden px-3 leading-normal {queued
            ? 'rounded-[0.875rem_0.875rem_0.25rem_0.875rem] border border-dashed border-(--solus-user-bubble-border) bg-(--solus-user-bubble) text-[0.75rem] leading-[1.5] text-(--solus-user-bubble-text) opacity-65'
            : 'rounded-[1rem_1rem_0.375rem_1rem] border border-(--solus-user-bubble-border) bg-(--solus-user-bubble) tracking-[-0.01em] text-(--solus-user-bubble-text) shadow-(--bubble-shadow)'}"
          class:py-1={!queued}
          class:py-1.5={queued}
          style:--bubble-shadow={theme.isDark
            ? 'inset 0 0.0625rem 0 rgba(255,255,255,0.06), 0 0.0625rem 0.1875rem rgba(0,0,0,0.2)'
            : 'inset 0 0.0625rem 0 rgba(255,255,255,0.8), 0 0.0625rem 0.1875rem rgba(0,0,0,0.06)'}
        >
          <div class="prose-cloud prose-user-bubble">
            <SvelteMarkdown source={text} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
          </div>
        </div>
        {#if queued && queueId && onCancel}
          <button
            type="button"
            onclick={() => onCancel!(queueId!)}
            title="Remove from queue"
            aria-label="Remove from queue"
            class="absolute -top-1.5 right-0 flex h-4 w-4 items-center justify-center rounded-full border border-(--solus-surface-tertiary) bg-(--solus-surface-secondary) text-(--solus-text-tertiary) transition-opacity duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {runtime.isTouchDevice ? 'opacity-100' : 'opacity-0 group-hover/queued:opacity-100'}"
          >
            <span class="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden" aria-hidden="true"></span>
            <XIcon size={8} weight="bold" />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if previewSrc}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      data-solus-ui
      use:portal={document.body}
      onclick={() => (previewSrc = null)}
      transition:fly={{ duration: 150 }}
      style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out"
    >
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <img
        src={previewSrc}
        onclick={(e) => e.stopPropagation()}
        style="max-width:90vw;max-height:90vh;border-radius:0.625rem;object-fit:contain;cursor:default"
        alt="preview"
      />
    </div>
  {/if}
{/snippet}

<!-- Stamp in the reading column's right margin (mirrors the assistant left-gutter
     stamp) in both modes — gutter room comes from the centered reading column in
     editor mode and from the pill column's horizontal inset in pill mode. The row
     opts out of content-visibility (.cv-stamp-host, handled by ConversationView's
     opt-out rule) so the margin stamp isn't clipped; the heavy content keeps the
     off-screen optimization via .user-cv-body. -->
<div
  data-testid="user-message"
  data-nav-msg-id={message?.id}
  class="cv-stamp-host group/user relative {skipMotion
    ? ''
    : 'animate-msg-in-up'}"
>
  {#if message?.timestamp && !queued && !runtime.isMobileViewport}
    <span
      class="cv-stamp-gutter-right text-[0.625rem] text-(--solus-text-tertiary) tabular-nums select-none transition-opacity duration-100 {runtime.isTouchDevice ? 'opacity-100' : 'opacity-0 group-hover/user:opacity-100'}"
    >
      {formatMessageTime(message.timestamp)}
    </span>
  {/if}
  <div class="user-cv-body flex flex-col items-end gap-1.5 pt-4 pb-1.5">
    {#if message?.via === "automation"}
      <button
        type="button"
        title={message.automationName
          ? `Open automation: ${message.automationName}`
          : "Open automation"}
        onclick={() => session.openAutomations(message?.automationId)}
        class="flex items-center gap-1 pr-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-secondary) focus-visible:outline-none focus-visible:text-(--solus-text-secondary)"
      >
        <LightningIcon size={11} weight="fill" />
        <span>Sent via automation</span>
      </button>
    {/if}
    {@render bubbleBody()}
  </div>
  {#if !queued && text && !runtime.isMobileViewport}
    <div
      class="absolute top-full right-0 -mt-1 z-10 transition-opacity duration-100 {runtime.isTouchDevice ? 'opacity-100' : 'opacity-0 group-hover/user:opacity-100'}"
    >
      <CopyButton text={text} />
    </div>
  {/if}
</div>

<style>
  /* Heavy content keeps the off-screen render skip; the row root opts out (see
     .cv-stamp-host opt-out in ConversationView) so the margin stamp isn't clipped. */
  .user-cv-body {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  /* Timestamp in the reading column's right margin, mirroring the assistant's
     left-gutter stamp. left:100% anchors its left edge to the panel's right edge
     and it extends into the gutter. bottom is tuned to the bubble's last text
     line (line-height:1 keeps the stamp's own baseline predictable). */
  .cv-stamp-gutter-right {
    position: absolute;
    left: 100%;
    bottom: 1.15rem;
    margin-left: 0.375rem;
    line-height: 1;
    white-space: nowrap;
  }

</style>
