<script lang="ts">
  import { CheckIcon, DotsThreeIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import type { AgentConversationRef } from "../../../../shared/types";
  import { getWorkspaceContext } from "../../../contexts";
  import { agentLabel } from "../../../lib/agentAvailability";
  import {
    agentAccent,
    agentConversationCardState,
    agentConversationElapsedMs,
    agentLatestLine,
    agentMessages,
    formatAgentConversationDuration,
    hostLabelFor,
    isLiveAgentConversationState,
    isPendingAgent,
    openAgentSession,
    provenanceLine,
    worktreeLabel,
  } from "./lib/agent-conversation";
  import { agentConversationStatus } from "./agent-conversation-status.store.svelte";
  import AgentDialogue from "./AgentDialogue.svelte";
  import AgentExchangeFooter from "./AgentExchangeFooter.svelte";
  import AgentTypingDots from "./AgentTypingDots.svelte";
  import { liveActivityClock } from "../../../lib/shared-clock";

  /**
   * Two or more agents in one turn share a single card: the tab row is the
   * roster, the body below is the selected agent's dialogue, identical to the
   * single-agent card. Never one card per agent — a turn that asked four things
   * would otherwise cost four headers, four clocks and four footers.
   *
   * Order is dispatch order and never re-sorts; a roster that reshuffles while
   * you read it is unusable.
   */
  interface Props {
    refs: AgentConversationRef[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { refs, tabId, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const api = $derived(session.apiFor(tabId));
  const serverId = $derived(session.sessionFor(tabId)?.run.serverId);

  $effect(() => {
    const releases: Array<() => void> = [];
    for (const ref of refs) {
      if (!isPendingAgent(ref)) {
        releases.push(agentConversationStatus.retain(ref.agentSessionId, api));
      }
    }
    return () => { for (const release of releases) release(); };
  });

  let now = $state(Date.now());
  const states = $derived(
    refs.map((ref) =>
      agentConversationCardState(ref, agentConversationStatus.statusFor(ref.agentSessionId), now),
    ),
  );
  const anyLive = $derived(states.some(isLiveAgentConversationState));

  $effect(() => {
    if (!anyLive) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  function nameOf(ref: AgentConversationRef): string {
    return agentLabel(agentConversationStatus.metaFor(ref.agentSessionId)?.provider ?? ref.provider);
  }

  function messageCountOf(ref: AgentConversationRef, live: boolean): number {
    return agentMessages(ref).filter((message) => live || !message.pending).length;
  }

  /** Precedence: an agent that needs you, then the most recently active, then
   *  the first dispatched. Never re-selected automatically once clicked. */
  const defaultIndex = $derived.by(() => {
    const blocked = states.indexOf("waiting");
    if (blocked !== -1) return blocked;
    let best = 0;
    for (const [index, ref] of refs.entries()) {
      const last = ref.exchanges[ref.exchanges.length - 1];
      const bestLast = refs[best].exchanges[refs[best].exchanges.length - 1];
      if ((last?.dispatchedAt ?? 0) > (bestLast?.dispatchedAt ?? 0)) best = index;
    }
    return best;
  });

  let pickedId = $state<string | null>(null);
  const selectedIndex = $derived.by(() => {
    const picked = refs.findIndex((ref) => ref.agentSessionId === pickedId);
    return picked === -1 ? defaultIndex : picked;
  });
  const selected = $derived(refs[selectedIndex]);
  const selectedState = $derived(states[selectedIndex]);
  const selectedLive = $derived(isLiveAgentConversationState(selectedState));
  const selectedName = $derived(nameOf(selected));
  const selectedQuestion = $derived(selected.exchanges[selected.exchanges.length - 1]?.question);

  const totalMessages = $derived(
    refs.reduce((sum, ref, index) => sum + messageCountOf(ref, isLiveAgentConversationState(states[index])), 0),
  );
  const totalElapsed = $derived(
    formatAgentConversationDuration(Math.max(0, ...refs.map((ref) => agentConversationElapsedMs(ref, now)))),
  );

  // The card must not resize when you switch tabs, so the body is fixed and
  // scrolls internally — with each tab's position kept, and the live one pinned
  // to its newest message.
  let bodyEl = $state<HTMLElement | null>(null);
  const scrollTops = new Map<string, number>();
  $effect(() => {
    const id = selected.agentSessionId;
    const body = bodyEl;
    if (!body) return;
    body.scrollTop = scrollTops.get(id) ?? body.scrollHeight;
  });
  // A reply landing follows the newest message only for a reader who was
  // already at the bottom — never yanked out from under one who scrolled back.
  const tail = $derived(agentMessages(selected).map((message) => message.text.length).join());
  $effect(() => {
    void tail;
    const body = bodyEl;
    if (!body || !selectedLive) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 40) body.scrollTop = body.scrollHeight;
  });

  function rememberScroll() {
    if (bodyEl) scrollTops.set(selected.agentSessionId, bodyEl.scrollTop);
  }

  /** Every agent has replied for this round: tabs and body give way to one line each. */
  let reopened = $state(false);
  const atRest = $derived(!anyLive && !reopened);

  function open(ref: AgentConversationRef, options: { split?: boolean; background?: boolean } = {}) {
    const provider = agentConversationStatus.metaFor(ref.agentSessionId)?.provider ?? ref.provider;
    void openAgentSession(
      ref,
      provider,
      api.getSessionInfo,
      {
        resume: (resumed, opts) => session.resumeSession(resumed, opts),
        openInSplit: (openedTabId) => session.openTabInSplit(openedTabId),
      },
      options,
    );
  }

  function provenanceFor(ref: AgentConversationRef): string {
    return provenanceLine(
      ref,
      agentConversationStatus.metaFor(ref.agentSessionId),
      hostLabelFor(serverId),
    );
  }

  async function send(text: string, scope: "one" | "all"): Promise<"sent" | "queued" | "failed"> {
    // Finished agents are never resumed silently, so "all" means every agent
    // still in flight.
    const targets =
      scope === "one"
        ? [selected]
        : refs.filter((ref, index) => isLiveAgentConversationState(states[index]) && !isPendingAgent(ref));
    const results = await Promise.allSettled(
      targets.map((ref) => api.promptSession(ref.agentSessionId, text, "queue")),
    );
    if (results.every((result) => result.status === "rejected")) return "failed";
    return results.some(
      (result) => result.status === "fulfilled" && result.value.disposition === "queued",
    )
      ? "queued"
      : "sent";
  }

  const liveCount = $derived(states.filter(isLiveAgentConversationState).length);
</script>

<!-- A settled agent still has a session, and the live footer that used to carry
     Open session is gone by then — so every finished agent keeps its own copy
     of the footer's two doors: a new tab, and split beside this conversation.
     Same pair, same menu as the single-agent card. -->
{#snippet openControls(ref: AgentConversationRef, name: string)}
  <button
    class="shrink-0 rounded-[7px] px-2 py-1 text-[12px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
    onclick={(e) => open(ref, { split: e.metaKey || e.ctrlKey, background: e.shiftKey })}
  >
    Open session
  </button>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex items-center justify-center shrink-0 size-[26px] rounded-[7px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
      aria-label="{name} session actions"
    >
      <DotsThreeIcon size={14} weight="bold" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[252px]">
      {#if provenanceFor(ref)}
        <div
          class="text-menu-meta px-2.5 pt-1 pb-2 font-mono break-words text-(--solus-text-tertiary)"
        >
          {provenanceFor(ref)}
        </div>
        <DropdownMenu.Separator />
      {/if}
      <DropdownMenu.Item onclick={() => open(ref, { split: true })}>
        Open in split view
      </DropdownMenu.Item>
      <DropdownMenu.Item onclick={() => navigator.clipboard.writeText(ref.agentSessionId)}>
        Copy session id
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

<div
  class="bg-card rounded-[13px] overflow-hidden shadow-[shadow:var(--solus-agent-card-shadow)] {skipMotion
    ? ''
    : 'animate-msg-in-side'}"
  data-testid="agent-conversation-switchboard"
>
  {#if atRest}
    <!-- The glyph sits in a fixed 12px slot and the rows carry the matching 36px
         indent, so the summary and every agent name below it start on the same
         vertical instead of the summary hanging out to its right. -->
    <div class="flex items-center gap-2 px-4 py-2.5 border-b-[0.5px] border-(--solus-agent-card-rule)">
      <CheckIcon
        size={12}
        weight="bold"
        class="shrink-0 w-3 text-[color-mix(in_oklch,var(--chart-3)_64%,var(--foreground))]"
      />
      <span class="text-[13px] font-medium">
        Round complete · {refs.length} agents replied
      </span>
      <span class="flex-1"></span>
      <span class="font-mono text-[11px] text-muted-foreground/55 tabular-nums">
        {totalMessages}
        {totalMessages === 1 ? "message" : "messages"} · {totalElapsed}
      </span>
      <button
        class="rounded-[7px] px-2 py-1 text-[12px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
        onclick={() => (reopened = true)}
      >
        Read
      </button>
    </div>

    <!-- All agent colour drops out at rest; each row carries the agent's own
         conclusion, quoted rather than summarised. -->
    {#each refs as ref, index (ref.agentSessionId)}
      {@const meta = agentConversationStatus.metaFor(ref.agentSessionId)}
      <!-- The row's controls sit beside its click target rather than inside it —
           the row reads the transcript here, the buttons leave for the session,
           and one can't be nested in the other. -->
      <div
        class="group/agent-row flex items-center gap-2.5 w-full pl-9 pr-2.5 hover:bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] {index >
        0
          ? 'border-t-[0.5px] border-(--solus-agent-card-rule)'
          : ''}"
      >
        <button
          class="flex items-baseline gap-2.5 flex-1 min-w-0 py-2 text-left cursor-pointer"
          onclick={() => {
            pickedId = ref.agentSessionId;
            reopened = true;
          }}
        >
          <!-- Fixed column so the quoted lines align down the list. The name is the
               row's subject and never truncates; the worktree beside it is the
               disambiguator and gives way, in mono because it is a path. -->
          <span class="flex items-baseline gap-1.5 shrink-0 w-[120px]">
            <span class="shrink-0 text-[12.5px] font-semibold">{nameOf(ref)}</span>
            <span class="min-w-0 truncate text-[12px] text-muted-foreground">
              {worktreeLabel(ref, meta)}
            </span>
          </span>
          <span class="flex-1 min-w-0 truncate text-[13px] text-muted-foreground">
            {agentLatestLine(ref, states[index])}
          </span>
        </button>
        {#if !isPendingAgent(ref)}
          <!-- Held back until the row is hovered, focused, or its menu is open:
               four rosters' worth of buttons would out-shout the conclusions
               they sit beside, which are what the summary is for. -->
          <span
            class="flex items-center gap-0.5 shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover/agent-row:opacity-100 has-[[data-state=open]]:opacity-100"
          >
            {@render openControls(ref, nameOf(ref))}
          </span>
        {/if}
      </div>
    {/each}
  {:else}
    <!-- Tab row — the roster, and it replaces the single-agent header. Never
         grows, never re-sorts; past six agents it scrolls rather than wraps. -->
    <div
      class="flex items-center gap-[7px] px-[11px] py-[9px] overflow-x-auto border-b-[0.5px] border-(--solus-agent-card-rule)"
    >
      {#each refs as ref, index (ref.agentSessionId)}
        {@const meta = agentConversationStatus.metaFor(ref.agentSessionId)}
        {@const state = states[index]}
        {@const isLive = isLiveAgentConversationState(state)}
        {@const isSelected = index === selectedIndex}
        <button
          class="flex items-center gap-[7px] shrink-0 rounded-lg px-[9px] py-[5px] cursor-pointer {isSelected
            ? state === 'waiting'
              ? 'bg-[color-mix(in_oklch,var(--chart-2)_15%,transparent)]'
              : 'bg-[color-mix(in_oklch,var(--agent-accent)_14%,transparent)]'
            : 'hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)]'}"
          style:--agent-accent={isLive ? agentAccent(index) : "var(--muted-foreground)"}
          onclick={() => (pickedId = ref.agentSessionId)}
        >
          <span
            class="text-[12.5px] font-semibold {isLive
              ? 'text-[color-mix(in_oklch,var(--agent-accent)_76%,var(--foreground))]'
              : 'text-muted-foreground'}"
          >
            {nameOf(ref)}
          </span>
          <span class="text-[12px] text-muted-foreground {isLive ? '' : 'opacity-80'}">
            {worktreeLabel(ref, meta)}
          </span>
          {#if state === "waiting"}
            <span
              class="rounded-[9px] px-1.5 py-px text-[11.5px] font-medium bg-[color-mix(in_oklch,var(--chart-2)_18%,transparent)] text-[color-mix(in_oklch,var(--chart-2)_74%,var(--foreground))]"
            >
              needs you
            </span>
          {:else if state === "failed"}
            <span class="text-[11.5px] font-medium text-(--destructive)">failed</span>
          {:else if isLive}
            <AgentTypingDots variant="chip" />
          {:else}
            <CheckIcon
              size={11}
              weight="bold"
              class="text-[color-mix(in_oklch,var(--chart-3)_64%,var(--foreground))]"
            />
          {/if}
        </button>
      {/each}
      <span class="flex-1"></span>
      {#if selectedLive}
        <span class="shrink-0 font-mono text-[11px] text-muted-foreground/55 tabular-nums">
          {formatAgentConversationDuration(agentConversationElapsedMs(selected, now))}
        </span>
      {:else if !isPendingAgent(selected)}
        <!-- The footer is live-only, so once the selected agent has settled its
             doors move up here — the same swap the single-agent card makes. -->
        {@render openControls(selected, selectedName)}
      {/if}
    </div>

    <div
      bind:this={bodyEl}
      onscroll={rememberScroll}
      class="h-[264px] overflow-y-auto px-4 pt-1"
      style:--agent-accent={selectedLive ? agentAccent(selectedIndex) : "var(--muted-foreground)"}
    >
      <AgentDialogue
        ref={selected}
        agentName={selectedName}
        live={selectedLive}
        clampPx={180}
        onOpen={isPendingAgent(selected) ? undefined : () => open(selected)}
      />
    </div>

    {#if selectedLive && !isPendingAgent(selected)}
      <AgentExchangeFooter
        agentName={selectedName}
        needsYou={selectedState === "waiting"}
        answerInSessionOnly={selectedState === "waiting" &&
          !!selectedQuestion &&
          selectedQuestion.kind !== "question"}
        onSend={send}
        onOpen={(options) => open(selected, options)}
        onStop={selectedState === "waiting"
          ? undefined
          : () => api.stopSession(selected.agentSessionId)}
        broadcastLabel={liveCount > 1 ? `Say it to all ${liveCount}` : undefined}
      />
    {/if}
  {/if}
</div>
