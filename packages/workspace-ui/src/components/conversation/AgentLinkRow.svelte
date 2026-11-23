<script lang="ts">
  import type { Snippet } from "svelte";
  import { ChevronRight as ChevronRightIcon } from "@lucide/svelte";
  import { isNestedInteractive } from "./lib/transcript-card";
  import { agentMarkShowsElapsed, type AgentLinkStatus } from "./lib/agent-link";
  import AgentAvatar from "./AgentAvatar.svelte";
  import AgentStateMark from "./AgentStateMark.svelte";

  /**
   * One agent in the transcript, as a flat row (T3 Code's subagent link): the
   * avatar, the title, one detail line, the state mark and the elapsed time,
   * and a chevron when there is something to open. A sub-agent and a session
   * another agent started both use it.
   */
  interface Props {
    provider: string;
    /** The standing, state mark, and accessible status label. */
    link: AgentLinkStatus;
    title: string;
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
    /** Under the line, indented to the title, inside the row: what the agent
     *  linked. A click on a control in it does not open the row. */
    below?: Snippet;
  }
  let {
    provider,
    link,
    title,
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
    below,
  }: Props = $props();

  const failed = $derived(link.standing === "failed");
  const showsElapsed = $derived(!!elapsed && agentMarkShowsElapsed(link.mark));

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
  class="group/agent flex w-full min-w-0 flex-col overflow-hidden rounded-md px-2 py-1.5 text-left {onOpen
    ? 'cursor-pointer transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] focus-visible:ring-2 focus-visible:ring-(--solus-accent-border-medium) focus-visible:outline-none focus-visible:ring-inset'
    : ''} {open ? 'bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]' : ''}"
  role={onOpen ? "button" : undefined}
  tabindex={onOpen ? 0 : undefined}
  aria-label={`${ariaLabel ?? (onOpen ? `Open ${title}` : title)}, ${link.label}`}
  title={hint ? `${link.label} · ${hint}` : link.label}
  aria-current={open ? "true" : undefined}
  data-testid={dataTestId}
  data-state={dataState}
  onclick={handleClick}
  onkeydown={handleKeydown}
>
  <div class="flex w-full min-w-0 items-center gap-2">
    <AgentAvatar {provider} variant="row" />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-xs font-medium text-(--solus-text-primary)">{title}</span>
      {#if detail}
        <span
          class="block truncate text-[0.6875rem] leading-relaxed {failed
            ? 'text-destructive'
            : 'text-muted-foreground'}">{detail}</span
        >
      {/if}
    </span>
    {#if trailing || link.mark || showsElapsed || onOpen}
      <span class="flex shrink-0 items-center gap-1.5">
        {#if trailing}{@render trailing()}{/if}
        <!-- The sidebar's grammar: the time, then the mark at the edge, so marks
             line up in one column. A live clock is in full ink, a settled one
             steps back. -->
        {#if link.mark || showsElapsed}
          <span class="flex shrink-0 items-center gap-2">
            {#if showsElapsed}
              <!-- A working agent's clock takes the tone of its dots, so the two
                   read as one unit; a settled one steps back. -->
              <span
                class="shrink-0 font-mono text-[0.625rem] font-medium tabular-nums {link.mark?.kind === 'dot'
                  ? 'text-(--solus-status-working)'
                  : 'text-[color-mix(in_oklch,var(--muted-foreground)_80%,transparent)]'}">{elapsed}</span
              >
            {/if}
            {#if link.mark}<AgentStateMark mark={link.mark} label={link.label} />{/if}
          </span>
        {/if}
        {#if onOpen}
          <ChevronRightIcon
            size={14}
            aria-hidden="true"
            class="shrink-0 text-[color-mix(in_oklch,var(--muted-foreground)_60%,transparent)] transition-colors group-hover/agent:text-(--solus-text-primary)"
          />
        {/if}
      </span>
    {/if}
  </div>
  {#if below}
    <div class="w-full min-w-0 pt-1 pl-6">{@render below()}</div>
  {/if}
</div>
