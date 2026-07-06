<script lang="ts">
  import { ChatCircleIcon, ArrowRightIcon } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "../conversation/MarkdownLink.svelte";
  import type { Message } from "../../../shared/types";
  import type { SessionLoadMessage } from "../../../shared/session-history";

  interface Props {
    messages: Array<SessionLoadMessage | Message> | null;
    loading: boolean;
    title?: string;
    byline?: string;
    timeAgo?: string | null;
    hiddenCountOverride?: number;
    onContinue?: () => void;
  }
  let {
    messages,
    loading,
    title = "",
    byline = "",
    timeAgo = null,
    hiddenCountOverride,
    onContinue,
  }: Props = $props();

  const markdownRenderers = { code: CodeBlock, codespan: CodeSpan, link: MarkdownLink };
  const MAX_PREVIEW_MESSAGES = 4;
  const SNIPPET_LIMIT = 220;

  function truncateAtWord(text: string, limit: number): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= limit) return clean;
    const sliced = clean.slice(0, limit);
    const lastSpace = sliced.lastIndexOf(" ");
    const cut = lastSpace > limit * 0.6 ? sliced.slice(0, lastSpace) : sliced;
    return cut.replace(/[,;:\-–—]+$/, "") + "…";
  }

  function getSnippet(m: SessionLoadMessage | Message): string {
    return truncateAtWord(m.content || "", SNIPPET_LIMIT);
  }

  function getFullContent(m: SessionLoadMessage | Message): string {
    return m.content || "";
  }

  function getRole(m: SessionLoadMessage | Message): string {
    return m.role;
  }

  function isToolCall(m: SessionLoadMessage | Message): boolean {
    return "toolName" in m && !!m.toolName;
  }

  const filtered = $derived(
    messages?.filter((m) => {
      const role = getRole(m);
      if (role !== "user" && role !== "assistant") return false;
      if (isToolCall(m)) return false;
      if (role === "assistant" && !(m.content || "").trim()) return false;
      return true;
    }) ?? [],
  );

  const lastAssistantIndex = $derived(
    (() => {
      for (let i = filtered.length - 1; i >= 0; i--) {
        if (getRole(filtered[i]) === "assistant") return i;
      }
      return -1;
    })(),
  );

  const lastAssistantMessage = $derived(
    lastAssistantIndex >= 0 ? filtered[lastAssistantIndex] : null,
  );

  const preceding = $derived(
    lastAssistantIndex >= 0 ? filtered.slice(0, lastAssistantIndex) : filtered,
  );

  const previewMessages = $derived(preceding.slice(0, MAX_PREVIEW_MESSAGES));

  const hiddenCount = $derived(
    hiddenCountOverride ?? Math.max(0, preceding.length - previewMessages.length),
  );

  const hasAnyContent = $derived(!!messages || loading);
</script>

<div class="flex h-full min-w-0 flex-col">
  {#if hasAnyContent && title}
    <div class="flex min-w-0 flex-shrink-0 items-center gap-3 px-[1.125rem] pb-2.5 pt-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          class="overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-[550] leading-[1.3] tracking-[-0.01em] text-[var(--solus-text-primary)]"
          title={title}
        >
          {title}
        </div>
        <div class="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-[var(--solus-text-tertiary)]">
          {#if byline}<span
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              >{byline}</span
            >{/if}
          {#if byline && timeAgo}<span class="flex-shrink-0 opacity-50">·</span
            >{/if}
          {#if timeAgo}<span
              class="flex-shrink-0 opacity-80 [font-variant-numeric:tabular-nums]"
              >{timeAgo}</span
            >{/if}
        </div>
      </div>
      {#if onContinue && messages}
        <button
          class="inline-flex flex-shrink-0 cursor-pointer items-center gap-[0.3125rem] rounded-[0.4375rem] border border-[var(--solus-accent-border)] bg-[var(--solus-accent-light)] px-[0.5625rem] py-[0.1875rem] text-[0.6563rem] text-[var(--solus-accent)] transition-[background-color,border-color,transform] duration-150 hover:translate-x-[0.0625rem] hover:border-[var(--solus-accent-border-medium)] hover:bg-[var(--solus-accent-soft)] focus-visible:border-[var(--solus-accent-border-medium)] focus-visible:outline-none"
          onclick={onContinue}
        >
          <span>Continue</span>
          <ArrowRightIcon size={10} />
        </button>
      {/if}
    </div>
  {/if}

  {#if !messages && !loading}
    <div class="flex h-full flex-col items-center justify-center gap-2.5">
      <ChatCircleIcon size={26} class="text-(--solus-text-muted) opacity-35" />
      <span class="text-[0.7188rem] tracking-[0.005em] text-[var(--solus-text-tertiary)]"
        >Select a session to preview</span
      >
    </div>
  {:else if loading}
    <div class="flex flex-1 flex-col gap-2.5 overflow-y-auto px-[1.125rem] pb-4 pt-0.5 [scrollbar-width:thin]">
      <div
        class="h-3 rounded-[0.375rem] bg-[linear-gradient(90deg,var(--solus-surface-hover)_25%,transparent_50%,var(--solus-surface-hover)_75%)] [background-size:25rem_100%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite]"
        style="width:55%"
      ></div>
      <div
        class="h-3 rounded-[0.375rem] bg-[linear-gradient(90deg,var(--solus-surface-hover)_25%,transparent_50%,var(--solus-surface-hover)_75%)] [background-size:25rem_100%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite]"
        style="width:78%"
      ></div>
      <div
        class="h-3 rounded-[0.375rem] bg-[linear-gradient(90deg,var(--solus-surface-hover)_25%,transparent_50%,var(--solus-surface-hover)_75%)] [background-size:25rem_100%] animate-[skeleton-shimmer_1.5s_ease-in-out_infinite]"
        style="width:42%"
      ></div>
    </div>
  {:else}
    <div class="flex flex-1 flex-col gap-2.5 overflow-y-auto px-[1.125rem] pb-4 pt-0.5 [scrollbar-width:thin]">
      {#if previewMessages.length > 0}
        <div class="flex flex-col gap-1.5 opacity-[0.92]">
          {#each previewMessages as m}
            {#if getRole(m) === "user"}
              <div
                class="ml-auto max-w-[78%] overflow-hidden break-words rounded-[0.625rem] bg-[var(--solus-user-bubble)] px-[0.6875rem] py-[0.4375rem] text-xs leading-[1.5]"
              >
                <span
                  class="text-[0.75rem]"
                  style="color:var(--solus-user-bubble-text)"
                  >{getSnippet(m)}</span
                >
              </div>
            {:else if getRole(m) === "assistant"}
              <div
                class="w-full overflow-hidden break-words rounded-l-none rounded-r-[0.625rem] border-l-2 border-l-[var(--solus-accent-light)] bg-transparent px-[0.6875rem] py-[0.4375rem] leading-[1.5]"
              >
                <div class="text-[0.75rem] leading-[1.55] text-(--solus-text-secondary)">
                  {getSnippet(m)}
                </div>
              </div>
            {/if}
          {/each}
        </div>
      {/if}

      {#if lastAssistantMessage}
        <div
          class="mb-0.5 mt-1 flex items-center gap-2.5 before:h-px before:flex-1 before:bg-[var(--solus-popover-border)] before:opacity-45 before:content-[''] after:h-px after:flex-1 after:bg-[var(--solus-popover-border)] after:opacity-45 after:content-['']"
        >
          <span
            class="whitespace-nowrap font-mono text-[0.5938rem] uppercase tracking-[0.08em] text-[var(--solus-text-tertiary)] opacity-85"
            >{hiddenCount > 0
              ? `+${hiddenCount} more · last reply`
              : "last reply"}</span
          >
        </div>
        <div
          class="w-full overflow-hidden break-words rounded-l-none rounded-r-[0.625rem] border-l-2 border-l-[var(--solus-accent-border-medium)] bg-transparent py-1 pl-3 pr-0 leading-[1.5]"
        >
          <div class="prose-cloud text-[0.75rem] leading-[1.6] min-w-0">
            <SvelteMarkdown
              source={getFullContent(lastAssistantMessage)}
              renderers={markdownRenderers}
              sanitizeUrl={markdownSanitizeUrl}
            />
          </div>
        </div>
      {:else if previewMessages.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2.5 pt-10">
          <span class="text-[0.7188rem] tracking-[0.005em] text-[var(--solus-text-tertiary)]"
            >No messages</span
          >
        </div>
      {/if}
    </div>
  {/if}
</div>
