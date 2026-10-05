<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronRight as ChevronRightIcon } from "@lucide/svelte";
  import { isNestedInteractive } from "./lib/transcript-card";
  import type { AgentLinkTone } from "./lib/agent-link";
  import AgentAvatar from "./AgentAvatar.svelte";

  /**
   * One agent in the transcript, as a flat row (T3 Code's subagent link): the
   * avatar, the title, one detail line, the elapsed time, and a chevron when
   * there is something to open. A sub-agent and a session another agent
   * started both use it.
   */
  interface Props {
    provider: string;
    tone: AgentLinkTone;
    title: string;
    /** `Running`, `Completed`, `Failed`. It is the detail line when there is no detail. */
    status: string;
    /** What the agent is on, or what it came back with. Plain text, one line. */
    detail?: string;
    elapsed?: string;
    /** Shown on hover: the model and effort. */
    hint?: string;
    /** The agent is open in the companion pane. */
    open?: boolean;
    ariaLabel?: string;
    "data-testid"?: string;
    "data-state"?: string;
    onOpen?: () => void;
    /** Cmd-click: open beside this conversation. */
    onOpenSecondary?: () => void;
    /** Extra controls before the time, such as ⋯. */
    trailing?: Snippet;
  }
  let {
    provider,
    tone,
    title,
    status,
    detail = "",
    elapsed = "",
    hint,
    open = false,
    ariaLabel,
    "data-testid": dataTestId,
    "data-state": dataState,
    onOpen,
    onOpenSecondary,
    trailing,
  }: Props = $props();

  const failed = $derived(tone === "failed");

  function handleClick(e: MouseEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    if ((e.metaKey || e.ctrlKey) && onOpenSecondary) {
      onOpenSecondary();
      return;
    }
    onOpen();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpen();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="group/agent flex w-full min-w-0 items-center overflow-hidden gap-2.5 rounded-md px-2 py-1.5 text-left {onOpen
    ? 'cursor-pointer transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-visible:ring-2 focus-visible:ring-(--solus-accent-border-medium) focus-visible:outline-none focus-visible:ring-inset'
    : ''} {open ? 'bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]' : ''}"
  role={onOpen ? "button" : undefined}
  tabindex={onOpen ? 0 : undefined}
  aria-label={`${ariaLabel ?? (onOpen ? `Open ${title}` : title)}, ${status}`}
  title={hint || undefined}
  aria-current={open ? "true" : undefined}
  data-testid={dataTestId}
  data-state={dataState}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <AgentAvatar {provider} {tone} />
  <span class="min-w-0 flex-1">
    <span class="flex items-baseline gap-2">
      <span class="min-w-0 truncate text-xs font-medium text-(--solus-text-primary)">{title}</span>
      {#if detail && tone !== "done"}
        <span class="shrink-0 text-[0.625rem] {failed ? 'text-destructive' : 'text-muted-foreground'}"
          >{status}</span
        >
      {/if}
    </span>
    <span
      class="block truncate text-[0.6875rem] leading-relaxed {failed
        ? 'text-destructive'
        : 'text-muted-foreground'}">{detail || status}</span
    >
  </span>
  {#if trailing}{@render trailing()}{/if}
  {#if elapsed}
    <span
      class="shrink-0 font-mono text-[0.625rem] tabular-nums text-[color-mix(in_oklch,var(--muted-foreground)_80%,transparent)]"
      >{elapsed}</span
    >
  {/if}
  {#if onOpen}
    <ChevronRightIcon
      size={14}
      aria-hidden="true"
      class="shrink-0 text-[color-mix(in_oklch,var(--muted-foreground)_60%,transparent)] transition-colors group-hover/agent:text-(--solus-text-primary)"
    />
  {/if}
</div>
