<script lang="ts">
  import { Check as CheckIcon } from "@lucide/svelte";
  import TranscriptCard from "../TranscriptCard.svelte";
  import TranscriptCardAction from "../TranscriptCardAction.svelte";
  import ClaudeIcon from "../../ClaudeIcon.svelte";
  import OpenAIBlossom from "../../pickers/OpenAIBlossom.svelte";
  import type { AgentConversationRef } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../../contexts";
  import { agentLabel } from "../../../lib/agentAvailability";
  import {
    agentAccent,
    agentConversationCardState,
    agentConversationElapsedMs,
    agentConversationTitle,
    agentMessages,
    awaitsHostWord,
    cardTaskId,
    directionFlow,
    formatAgentConversationDuration,
    hostLabelFor,
    isLiveAgentConversationState,
    isPendingAgent,
    openAgentSession,
    pendingRequest,
    planAwaitingDecision,
    provenanceLine,
  } from "./lib/agent-conversation";
  import { agentConversationMeta } from "./agent-conversation-meta.store.svelte";
  import { sentMessages } from "./sent-messages.store.svelte";
  import AgentPlanDecision from "./AgentPlanDecision.svelte";
  import AgentRequestCard from "./AgentRequestCard.svelte";
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

  /** No real session id yet (start_session still starting, or it failed) —
   *  nothing to open, prompt, or track. */
  const neverStarted = $derived(isPendingAgent(ref));

  $effect(() => {
    if (neverStarted) return;
    return agentConversationMeta.retain(ref.agentSessionId, api, serverId);
  });

  const meta = $derived(agentConversationMeta.metaFor(ref.agentSessionId));
  const senderSessionId = $derived(session.sessionFor(tabId)?.id);
  // A message rebuilt from the transcript asks the host whether it is still live.
  $effect(() => {
    if (neverStarted || !senderSessionId || !awaitsHostWord(ref)) return;
    return sentMessages.retain(senderSessionId, api, serverId);
  });
  const lastExchange = $derived(ref.exchanges[ref.exchanges.length - 1]);
  const carried = $derived(
    lastExchange?.restored && senderSessionId
      ? sentMessages.lookup(senderSessionId, serverId, lastExchange.messageId)
      : undefined,
  );
  let now = $state(Date.now());
  const cardState = $derived(agentConversationCardState(ref, carried));
  const live = $derived(isLiveAgentConversationState(cardState));
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
  const flow = $derived(directionFlow(cardState));
  // What the other agent's turn waits on a person for; answered right here.
  const request = $derived(cardState === "waiting" ? pendingRequest(ref, carried) : null);
  const taskId = $derived(cardTaskId(ref));
  const planToDecide = $derived(live ? null : planAwaitingDecision(ref));

  // The header is the whole summary; the dialogue is read in the agent's own
  // session. A body appears only when the other agent waits on a person here.
  const needsDecision = $derived(!!request || !!planToDecide);

  function open(options: { split?: boolean; background?: boolean } = {}) {
    void openAgentSession(
      ref,
      provider,
      serverId,
      {
        resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
        openInSplit: (openedTabId) => session.openTabInSplit(openedTabId),
      },
      options,
    );
  }

  function stop() {
    void api.stopSession(ref.agentSessionId);
  }

  // The provider mark names the agent, so the conversation title is the card's
  // title. The type slot keeps a settled card's reason, which never truncates.
  const reason = $derived(
    cardState === "failed"
      ? neverStarted
        ? "never started"
        : "stopped replying"
      : cardState === "lost"
        ? "reply lost in a restart"
        : cardState === "closed"
          ? "closed its session"
          : undefined,
  );
</script>

<!-- Colour is identity for the other agent while the exchange is live; the
     message blocks in the body read the same variable. -->
<div
  class="contents"
  style:--agent-accent={live ? agentAccent(accentIndex) : "var(--muted-foreground)"}
>
  <TranscriptCard
    {title}
    type={reason}
    waiting={cardState === "waiting"}
    failed={cardState === "failed"}
    superseded={cardState === "closed"}
    ariaLabel="Open {agentName} session: {title}"
    bodyLayout="prose"
    onOpen={neverStarted ? undefined : () => open()}
    onOpenSecondary={neverStarted ? undefined : () => open({ split: true })}
    menu={neverStarted ? undefined : cardMenu}
    body={needsDecision ? decisionBody : undefined}
    secondaryActionLabel="Open {agentName} beside this conversation"
    {skipMotion}
    data-testid="agent-conversation-card"
  >
    {#snippet glyph()}
      <span
        class="flex size-5 items-center justify-center rounded-md [&>svg]:size-3! {!live
          ? 'bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] text-muted-foreground'
          : provider === 'codex'
            ? 'bg-white text-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]'
            : provider === 'claude-code'
              ? 'bg-[color-mix(in_srgb,#c15f2c_12%,transparent)] text-[#c15f2c] shadow-[inset_0_0_0_1px_color-mix(in_srgb,#c15f2c_18%,transparent)]'
              : 'bg-[color-mix(in_oklch,var(--agent-accent)_17%,transparent)] text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]'}"
        aria-label="{agentName} session"
      >
        {@render providerMark(12)}
      </span>
    {/snippet}

    {#snippet rail()}
      {#if live}
        <!-- The pair reads as one sentence: whoever is speaking carries the
             weight. "you" is emphasised by weight, never a tint: colour means
             "the other agent" everywhere in this card. -->
        <span class="flex items-center gap-1.5 font-sans">
          <span class={flow === "to-agent" ? "font-medium text-foreground" : ""}>you</span>
          <span class="relative h-[5px] w-[30px]" aria-hidden="true">
            <span
              class="absolute inset-x-0 top-0.5 h-px bg-[color-mix(in_oklch,var(--foreground)_15%,transparent)]"
            ></span>
            {#if flow}
              <span
                class="absolute right-1 top-0 size-[5px] rounded-full bg-[color-mix(in_oklch,var(--agent-accent)_80%,var(--foreground))]"
              ></span>
            {/if}
          </span>
          <!-- The agent end is its mark, not its name: the glyph already names it. -->
          <span
            class="flex items-center {flow === 'to-you'
              ? 'text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]'
              : 'text-muted-foreground'}"
            aria-label={agentName}
          >
            {@render providerMark(11)}
          </span>
        </span>
        <span class="tabular-nums">{elapsed}</span>
      {:else}
        {#if cardState === "replied"}
          <CheckIcon
            size={11}
            class="text-[color-mix(in_oklch,var(--chart-3)_70%,var(--foreground))]"
          />
        {/if}
        <span>{messageCount} {messageCount === 1 ? "message" : "messages"}</span>
      {/if}
    {/snippet}
  </TranscriptCard>
</div>

{#snippet providerMark(size: number)}
  {#if provider === "codex"}
    <OpenAIBlossom {size} fill="currentColor" />
  {:else if provider === "claude-code"}
    <ClaudeIcon {size} />
  {:else}
    <span class="text-[0.5625rem] font-medium">Oc</span>
  {/if}
{/snippet}

{#snippet decisionBody()}
  <!-- A click in the answer must not open the session. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="cursor-auto text-transcript-meta" onclick={(e) => e.stopPropagation()}>
    {#if planToDecide}
      <div class="pb-0.5">
        <AgentPlanDecision {tabId} targetAgentSessionId={ref.agentSessionId} />
      </div>
    {/if}
    {#if request}
      <AgentRequestCard {ref} {request} {tabId} />
    {/if}
  </div>
{/snippet}

{#snippet cardMenu()}
  <!-- Provenance on demand: none of it earns space on the card. A local
       session on an unknown model has nothing to say here. -->
  {#if provenance}
    <div class="text-transcript-meta max-w-60 px-2.5 pt-1 pb-2 break-words text-(--solus-text-tertiary)">
      {provenance}
    </div>
  {/if}
  <TranscriptCardAction kind="item" onclick={() => open()}>
    Open in a new tab
  </TranscriptCardAction>
  {#if taskId}
    <TranscriptCardAction kind="item" onclick={() => session.goToTask(taskId, "click")}>
      Open its task
    </TranscriptCardAction>
  {/if}
  <TranscriptCardAction
    kind="item"
    onclick={() => void navigator.clipboard.writeText(ref.agentSessionId)}
  >
    Copy session id
  </TranscriptCardAction>
  {#if live && cardState !== "waiting"}
    <TranscriptCardAction kind="item" destructive onclick={stop}>
      Stop {agentName}
    </TranscriptCardAction>
  {/if}
{/snippet}
