<script lang="ts">
  import {
    ArrowSquareOutIcon,
    CheckIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import ClaudeIcon from "../../ClaudeIcon.svelte";
  import OpenAIBlossom from "../../pickers/OpenAIBlossom.svelte";
  import type { AgentConversationRef } from "../../../../shared/types";
  import { getWorkspaceContext } from "../../../contexts";
  import { agentLabel } from "../../../lib/agentAvailability";
  import {
    agentAccent,
    agentConversationCardState,
    agentConversationElapsedMs,
    agentConversationTitle,
    agentMessages,
    directionFlow,
    formatAgentConversationDuration,
    hostLabelFor,
    isLiveAgentConversationState,
    isPendingAgent,
    openAgentSession,
    provenanceLine,
  } from "./lib/agent-conversation";
  import { agentConversationStatus } from "./agent-conversation-status.store.svelte";
  import AgentDialogue from "./AgentDialogue.svelte";
  import AgentExchangeFooter from "./AgentExchangeFooter.svelte";
  import { liveActivityClock } from "../../../lib/shared-clock";

  /**
   * This session's conversation with one other agent's session — one card per
   * exchange per turn, never one per message. The other agent gets its provider
   * mark and colour; you get neither, which is the single rule that answers "which agent
   * is which". Host, worktree, model and session id never render here: they live
   * behind Open session and the ⋯ menu.
   */
  interface Props {
    ref: AgentConversationRef;
    tabId: string;
    skipMotion?: boolean;
    /** Colour is assigned by dispatch order within the turn, not by vendor. */
    accentIndex?: number;
  }
  let { ref, tabId, skipMotion = false, accentIndex = 0 }: Props = $props();

  const session = getWorkspaceContext();

  // The other agent lives on the same host as the caller's tab — every RPC must
  // route through that tab's server, not the local default.
  const api = $derived(session.apiFor(tabId));
  const serverId = $derived(session.sessionFor(tabId)?.run.serverId);

  /** No real session id yet (create_session still starting, or it failed) —
   *  nothing to open, prompt, or track. */
  const neverStarted = $derived(isPendingAgent(ref));

  $effect(() => {
    if (neverStarted) return;
    return agentConversationStatus.retain(ref.agentSessionId, api, serverId);
  });

  const meta = $derived(agentConversationStatus.metaFor(ref.agentSessionId));
  const agentStatus = $derived(
    agentConversationStatus.statusFor(ref.agentSessionId),
  );
  let now = $state(Date.now());
  const state = $derived(agentConversationCardState(ref, agentStatus, now));
  const live = $derived(isLiveAgentConversationState(state));
  // Reloaded transcripts default the provider; the index knows the truth.
  const provider = $derived(meta?.provider ?? ref.provider);
  const agentName = $derived(agentLabel(provider));
  const title = $derived(agentConversationTitle(ref, meta));
  const provenance = $derived(
    provenanceLine(ref, meta, hostLabelFor(serverId)),
  );

  $effect(() => {
    if (!live) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const elapsed = $derived(
    formatAgentConversationDuration(agentConversationElapsedMs(ref, now)),
  );
  const messageCount = $derived(
    agentMessages(ref).filter((message) => live || !message.pending).length,
  );
  const flow = $derived(directionFlow(state));
  const lastExchange = $derived(ref.exchanges[ref.exchanges.length - 1]);
  // A permission or a plan can't be answered by typing at it — that one has to
  // be taken in the agent's own session.
  const answerInSessionOnly = $derived(
    state === "waiting" &&
      !!lastExchange?.question &&
      lastExchange.question.kind !== "question",
  );

  // Every card folds to its header, which is already the whole summary. Only the
  // starting position differs: a launched session owes this conversation nothing,
  // so it rests folded and the reader follows it in its own session. A card
  // blocked on a human unfolds itself — that is the one thing the header can't
  // say, and the answer field lives in the body — until the reader rules on it.
  let openedByUser = $state<boolean | null>(null);
  const bodyOpen = $derived(
    openedByUser ?? (state === "waiting" || !ref.fireAndForget),
  );

  function open(options: { split?: boolean; background?: boolean } = {}) {
    void openAgentSession(
      ref,
      provider,
      serverId,
      {
        resume: (resumed, opts) => session.resumeSession(resumed, opts),
        openInSplit: (openedTabId) => session.openTabInSplit(openedTabId),
      },
      options,
    );
  }

  function stop() {
    void api.stopSession(ref.agentSessionId);
  }

  /** Retry resumes the same session, never a new one. */
  function retry() {
    if (!lastExchange?.prompt) return open();
    void api.promptSession(ref.agentSessionId, lastExchange.prompt, "queue");
  }

  async function send(text: string): Promise<"sent" | "queued" | "failed"> {
    try {
      const result = await api.promptSession(ref.agentSessionId, text, "queue");
      return result.disposition === "queued" ? "queued" : "sent";
    } catch {
      return "failed";
    }
  }

  // A state ring is a full pixel of colour where the resting card carries a
  // half-pixel inset hairline; both sit over the same lift, so no state changes
  // the card's height or reads as a different object.
  const stateRing = $derived(
    state === "waiting"
      ? "shadow-[shadow:0_0_0_1px_color-mix(in_oklch,var(--chart-2)_40%,transparent),var(--solus-agent-card-lift)]"
      : state === "failed"
        ? "shadow-[shadow:0_0_0_1px_color-mix(in_oklch,var(--destructive)_32%,transparent),var(--solus-agent-card-lift)]"
        : "shadow-[shadow:var(--solus-agent-card-shadow)]",
  );
</script>

<div
  class="text-xs group/agent-card bg-card rounded-2xl overflow-hidden {stateRing} {state ===
 'closed'
 ? 'opacity-70'
 : ''} {skipMotion ? '' : 'animate-msg-in-side'}"
  style:--agent-accent={live
    ? agentAccent(accentIndex)
    : "var(--muted-foreground)"}
  data-testid="agent-conversation-card"
>
  <!-- Header — five slots, identical in every state so nothing shifts as the
       exchange progresses. The title truncates first; the name and the state
       never truncate. -->
  <div
    class="flex items-center gap-[11px] pt-[13px] pr-[15px] pb-[13px] pl-[14px] border-b-[0.5px] transition-colors duration-200 {bodyOpen
 ? 'border-(--solus-agent-card-rule)'
 : 'border-transparent'}"
  >
    <!-- Sixth slot. Muted to near-invisible until the card is hovered or the
         body is folded: a control that is always available is not always worth
         looking at, and the header's job is to be read, not operated. -->
    <button
      class="flex items-center justify-center shrink-0 -ml-1 -mr-[3px] size-[18px] rounded-[0.3125rem] cursor-pointer transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] focus-visible:text-foreground {bodyOpen
 ? 'text-transparent group-hover/agent-card:text-muted-foreground'
 : 'text-muted-foreground'}"
      aria-expanded={bodyOpen}
      aria-label="{bodyOpen ? 'Collapse' : 'Expand'} {agentName} exchange"
      onclick={() => (openedByUser = !bodyOpen)}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="transition-transform {bodyOpen ? 'rotate-90' : ''}"
      >
        <path d="M4.2 2.4L7.8 6l-3.6 3.6" />
      </svg>
    </button>
    <span
      class="flex items-center justify-center shrink-0 size-6 rounded-lg {provider ===
 'codex'
 ? 'bg-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]'
 : provider === 'claude-code'
 ? 'bg-[color-mix(in_srgb,#c15f2c_12%,transparent)] text-[#c15f2c] shadow-[inset_0_0_0_1px_color-mix(in_srgb,#c15f2c_18%,transparent)]'
 : 'bg-[color-mix(in_oklch,var(--agent-accent)_17%,transparent)] text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]'}"
      aria-label="{agentName} session"
    >
      {#if provider === "codex"}
        <OpenAIBlossom size={14} />
      {:else if provider === "claude-code"}
        <ClaudeIcon size={14} />
      {:else}
        <span class="font-medium">Oc</span>
      {/if}
    </span>
    <span
      class="shrink-0 text-sm font-medium text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]"
    >
      {agentName}
    </span>
    <span class="min-w-0 truncate text-sm text-muted-foreground"
      >{title}</span
    >
    <span class="flex-1"></span>

    {#if live}
      <!-- The pair reads as one sentence: whoever is speaking carries the
           emphasis, and the dot travels toward whoever is being spoken to. With
           nothing in flight — the agent is blocked on you — both ends go quiet
           and only the rule is left. "you" is emphasised by weight and
           full-strength text, never a tint: colour means "the other agent"
           everywhere else in this card, and one tinted "you" would undo it. -->
      <span class="flex items-center gap-[7px] shrink-0">
        <span
          class="{flow === 'to-agent'
 ? 'font-medium text-foreground'
 : 'text-muted-foreground'}"
        >
          you
        </span>
        <span class="relative w-[38px] h-[9px]">
          <span
            class="absolute inset-x-0 top-1 h-px bg-[color-mix(in_oklch,var(--foreground)_15%,transparent)]"
          ></span>
          {#if flow}
            <span
              class="agent-flow-dot--{flow} absolute left-0 top-0.5 size-[5px] rounded-full bg-[color-mix(in_oklch,var(--agent-accent)_80%,var(--foreground))]"
            ></span>
          {/if}
        </span>
        <span
          class="{flow === 'to-you'
 ? 'font-medium text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]'
 : 'text-muted-foreground'}"
        >
          {agentName}
        </span>
        <span
          class="ml-[3px]  text-muted-foreground/55 tabular-nums"
        >
          {elapsed}
        </span>
      </span>
    {:else if state === "failed"}
      <span class="shrink-0 text-sm text-(--destructive)">
        {neverStarted ? "never started" : "stopped replying"}
      </span>
      <span class="shrink-0 text-sm text-muted-foreground">
        {messageCount}
        {messageCount === 1 ? "message" : "messages"} kept
      </span>
      {#if !neverStarted}
        <button
          class="shrink-0 rounded-lg px-2 py-1  text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
          onclick={retry}
        >
          Retry
        </button>
      {/if}
    {:else}
      {#if state === "closed"}
        <span class="shrink-0 text-sm text-muted-foreground">
          closed its session · transcript kept
        </span>
      {:else}
        <CheckIcon
          size={12}
          weight="bold"
          class="shrink-0 text-[color-mix(in_oklch,var(--chart-3)_64%,var(--foreground))]"
        />
      {/if}
      <span class="shrink-0 text-sm text-muted-foreground">
        {messageCount}
        {messageCount === 1 ? "message" : "messages"}
      </span>
    {/if}

    {#if !neverStarted}
      <button
        class="flex items-center justify-center shrink-0 size-[26px] rounded-lg text-muted-foreground cursor-pointer transition-[background-color,color,scale] hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground active:scale-[0.96]"
        title="Open session in a new tab"
        aria-label="Open {agentName} session in a new tab"
        onclick={() => open()}
      >
        <ArrowSquareOutIcon size={14} />
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          class="flex items-center justify-center shrink-0 size-[26px] rounded-lg text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
          aria-label="{agentName} exchange actions"
        >
          <DotsThreeIcon size={14} weight="bold" />
        </DropdownMenu.Trigger>
        <!-- Width is explicit because the trigger is a 26px glyph and Content
             defaults to the anchor's width — left alone it collapses to the
             128px floor and every row wraps out of its 32px box. -->
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[252px]"
        >
          <!-- Provenance on demand — none of this earns space in the card. It
               is a fact, not a section heading, so it gets its own block rather
               than a menu-heading, which is uppercase and locked to one line.
               A local session on an unknown model has nothing to say here, and
               an empty block plus its separator is worse than neither. -->
          {#if provenance}
            <div
              class="px-2.5 pt-1 pb-2 break-words text-(--solus-text-tertiary)"
            >
              {provenance}
            </div>
            <DropdownMenu.Separator />
          {/if}
          <DropdownMenu.Item onclick={() => open({ split: true })}>
            Open in split view
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onclick={() => navigator.clipboard.writeText(ref.agentSessionId)}
          >
            Copy session id
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </div>

  <div class="agent-card-fold {bodyOpen ? '' : 'agent-card-fold--closed'}">
    <div class="min-h-0 overflow-hidden">
      <div class="px-4 pt-1">
        <AgentDialogue
          {ref}
          {agentName}
          {live}
          onOpen={neverStarted ? undefined : () => open()}
        />
      </div>

      {#if live && !neverStarted}
        <AgentExchangeFooter
          {agentName}
          needsYou={state === "waiting"}
          {answerInSessionOnly}
          onSend={send}
          onOpen={open}
          onStop={state === "waiting" ? undefined : stop}
        />
      {/if}
    </div>
  </div>
</div>
