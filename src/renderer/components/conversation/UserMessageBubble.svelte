<script lang="ts">
  import { fly } from "svelte/transition";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import MarkdownLink from "./MarkdownLink.svelte";
  import MarkdownText from "./MarkdownText.svelte";
  import MessageHoverRail from "./MessageHoverRail.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import { FileTextIcon, ImageIcon, FileCodeIcon, FileIcon, LightningIcon } from "phosphor-svelte";
  import { getWorkspaceContext, runtime } from "../../contexts";
  import { requestFilePreview } from "../../lib/filePreview";
  import { portal } from "../portal";
  import { formatMessageTime } from "../../lib/sessionUtils";
  import { formatWaited } from "./lib/queued-prompts";
  import { shouldCollapseUserMessage } from "./lib/user-message";
  import type { Message, OutboundPromptState } from "../../../shared/types";
  import type { Component } from "svelte";

  const markdownRenderers = { link: MarkdownLink, codespan: CodeSpan, text: MarkdownText };

  interface Props {
    message?: Message;
    content?: string;
    attachments?: Message['attachments'];
    deliveryState?: 'sent' | OutboundPromptState;
    /** Position in the queue, printed beside the bubble. Only set when more than
     *  one prompt is held — a lone bubble has no order to state. */
    ordinal?: number;
    /** Rewrite a held prompt in place, keeping its slot in the queue. */
    onEditSubmit?: (text: string) => void;
    /** Drop a held prompt. The queue's only per-message escape. */
    onRemove?: () => void;
    skipMotion?: boolean;
  }
  let { message, content, attachments, deliveryState = 'sent', ordinal, onEditSubmit, onRemove, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();

  const text = $derived(content ?? message?.content ?? "");
  const isPending = $derived(deliveryState !== 'sent');
  const isAutomation = $derived(message?.via === "automation");
  const hasControls = $derived(isPending && (!!onEditSubmit || !!onRemove));
  const canCollapse = $derived(!isPending && shouldCollapseUserMessage(text));
  // The wait is only worth stating on the bubble that actually served it.
  const waitedLabel = $derived(
    message?.queuedWaitMs
      ? `sent ${formatMessageTime(message.timestamp)} · waited ${formatWaited(message.queuedWaitMs)}`
      : '',
  );

  let isEditing = $state(false);
  let isExpanded = $state(false);
  let draft = $state("");
  let editEl = $state<HTMLTextAreaElement | null>(null);

  function startEdit() {
    draft = text;
    isEditing = true;
  }

  function commitEdit() {
    const next = draft.trim();
    isEditing = false;
    if (next && next !== text) onEditSubmit?.(next);
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      isEditing = false;
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    }
  }

  $effect(() => {
    if (isEditing) editEl?.focus();
  });

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
          <span class="text-xs font-medium truncate text-(--solus-text-secondary)" style="min-width:0">
            {a.name}
          </span>
        </button>
      {/each}
    </div>
  {/if}

  {#if text}
    <!-- Three shapes, no hue: a 2% fill means a person typed it, a hairline
         card means an agent or automation sent it, and a fill plus an outline
         means it exists but hasn't gone out yet. -->
    <div class="flex w-full items-center justify-end gap-2">
      {#if ordinal !== undefined}
        <!-- Ordinals carry the order, so nothing inside the bubble has to. -->
        <span class="shrink-0 font-mono text-xs text-(--muted-foreground) opacity-45">
          {ordinal}
        </span>
      {/if}
      <!-- A held prompt is its own focusable region: its controls only paint on
           hover, so focus is what keeps them reachable from the keyboard. The
           tabindex is the point of the pattern, not an oversight. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        data-delivery={deliveryState}
        role={hasControls ? "group" : undefined}
        aria-label={hasControls ? "Queued prompt" : undefined}
        tabindex={hasControls ? 0 : undefined}
        class="group/bubble relative max-w-[41.25rem] overflow-hidden rounded-2xl px-3 pt-2.5 pb-2.5 outline-none {hasControls
 ? 'min-w-[9.5rem]'
 : 'min-w-0'} {isPending
 ? 'queued-bubble'
 : isAutomation
 ? 'bg-card shadow-[shadow:var(--solus-tx-hairline)]'
 : 'bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)]'}"
      >
        {#if isAutomation}
          <!-- Required origin label: the only thing separating an agent-sent
               message from a person's is this line plus the missing fill. -->
          <button
            type="button"
            title={message?.automationName
              ? `Open automation: ${message.automationName}`
              : "Open automation"}
            onclick={() => session.openAutomations(message?.automationId)}
            class="mb-[0.1875rem] flex items-center gap-1 text-xs font-medium text-(--solus-text-tertiary) uppercase transition-colors duration-100 hover:text-(--solus-text-secondary) focus-visible:text-(--solus-text-secondary) focus-visible:outline-none"
          >
            <LightningIcon size={9} weight="fill" />
            <span>{message?.automationName || "Automation"}</span>
          </button>
        {/if}
        {#if isEditing}
          <!-- Editing keeps the prompt's slot in the queue, so it stays inside
               the bubble that owns it rather than travelling to the composer. -->
          <textarea
            bind:this={editEl}
            bind:value={draft}
            onkeydown={handleEditKeydown}
            onblur={commitEdit}
            rows={Math.min(8, draft.split("\n").length + 1)}
            class="w-full resize-none bg-transparent text-[0.8125rem] leading-[1.55] text-(--solus-text-primary) outline-none"
          ></textarea>
        {:else}
          <div class="relative">
            <div
              class="prose-cloud prose-transcript-user {isPending ? 'opacity-[0.6]' : ''} {canCollapse && !isExpanded ? 'user-message-collapsed' : ''}"
              data-conversation-message-content
              data-conversation-message-id={message?.id}
            >
              <SvelteMarkdown
                source={text}
                renderers={markdownRenderers}
                sanitizeUrl={markdownSanitizeUrl}
              />
            </div>
          </div>
          {#if canCollapse}
            <button
              type="button"
              aria-expanded={isExpanded}
              onclick={() => (isExpanded = !isExpanded)}
              class="mt-0.5 flex min-h-10 w-full cursor-pointer items-center justify-end text-xs font-medium text-(--solus-text-tertiary) transition-[color,transform] duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none active:scale-[0.96]"
            >
              {isExpanded ? "Show less" : "Read more"}
            </button>
          {/if}
        {/if}
        {#if hasControls && !isEditing}
          <!-- Collapsed to nothing until reached for: the bubble is only as tall
               as its words, and grows into the controls on hover or focus. The
               0fr→1fr row is what makes that a movement rather than a jump, so
               the prompts below it slide instead of snapping. The bubble's
               min-width stops "Edit … Remove" clipping under a short prompt. -->
          <div
            class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-150 ease-out group-hover/bubble:grid-rows-[1fr] group-focus-within/bubble:grid-rows-[1fr]"
          >
            <div class="overflow-hidden">
              <div
                class="mt-2 flex items-center gap-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_8%,transparent)] pt-1.5 opacity-0 transition-opacity duration-150 ease-out group-hover/bubble:opacity-100 group-focus-within/bubble:opacity-100"
              >
                {#if onEditSubmit}
                  <button
                    type="button"
                    onclick={startEdit}
                    class="cursor-pointer text-xs text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
                  >
                    Edit
                  </button>
                {/if}
                <span class="flex-1"></span>
                {#if onRemove}
                  <button
                    type="button"
                    onclick={onRemove}
                    class="cursor-pointer text-xs text-(--solus-text-tertiary) opacity-60 transition-all duration-100 hover:text-(--destructive) hover:opacity-100 focus-visible:text-(--destructive) focus-visible:opacity-100 focus-visible:outline-none"
                  >
                    Remove
                  </button>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </div>
    </div>
    {#if waitedLabel}
      <!-- The wait is over, so the caption is a fact, not a countdown. -->
      <div class="mt-1.5 flex justify-end font-mono text-xs text-(--muted-foreground)">
        {waitedLabel}
      </div>
    {/if}
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
        style="max-width:90vw;max-height:90vh;border-radius:1rem;object-fit:contain;cursor:default"
        alt="preview"
      />
    </div>
  {/if}
{/snippet}

<!-- The rail hangs in the message's outer margin and aligns with the bottom of
     the bubble. The heavy body retains its off-screen rendering optimization. -->
<div
  data-testid="user-message"
  data-nav-msg-id={message?.id}
  class="cv-rail-host relative {skipMotion ? '' : 'animate-msg-in-up'}"
>
  <!-- A held message has nothing worth copying yet and states its own time in
       the caption, so it gets no rail. -->
  {#if !runtime.isMobileViewport && !isPending}
    <MessageHoverRail timestamp={message?.timestamp} text={text} side="right" />
  {/if}
  <!-- Held prompts stack as one block at 6px, not as separate messages: the
       queue is a single object in the transcript, and its group caption has to
       sit flush under the last bubble. -->
  <div
    class="user-cv-body flex flex-col items-end gap-1.5 {isPending
 ? 'py-[0.1875rem]'
 : 'pt-4 pb-1.5'}"
  >
    {@render bubbleBody()}
  </div>
</div>

<style>
  /* Typed but held — the limit is spent or the session is mid-turn. No fill at
     all, and the only dashed edge in the transcript: the shell says the words
     exist, the missing fill says they haven't been sent. */
  .queued-bubble {
    background: none;
    border: 0.0625rem dashed
      color-mix(in oklch, var(--foreground) 18%, transparent);
  }

  /* Reaching for a held prompt firms it up: the shell it will keep once it
     sends, minus the fill it has not earned yet. The text comes forward with
     it, because you are about to act on those words. */
  .queued-bubble:hover,
  .queued-bubble:focus-within {
    border-color: color-mix(in oklch, var(--foreground) 30%, transparent);
    background: color-mix(in oklch, var(--foreground) 3%, transparent);
  }
  .queued-bubble:hover :global(.prose-transcript-user),
  .queued-bubble:focus-within :global(.prose-transcript-user) {
    opacity: 0.75;
  }

  .user-cv-body {
    content-visibility: auto;
    contain-intrinsic-size: auto 3rem;
  }

  .user-message-collapsed {
    max-height: 13rem;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black calc(100% - 2.5rem), transparent);
  }

</style>
