<script lang="ts">
  import {
    Ellipsis as EllipsisIcon,
    PanelRight as PanelRightIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import * as Popover from "../../ui/popover";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { copyText, toasts } from "../../../lib/toasts";
  import AgentLinkRow from "../AgentLinkRow.svelte";
  import TranscriptCardAction from "../TranscriptCardAction.svelte";
  import type { AgentConversationRef } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../../contexts";
  import { agentLabel } from "../../../lib/agentAvailability";
  import {
    agentAccent,
    agentConversationCardState,
    agentConversationElapsedMs,
    agentConversationLink,
    agentConversationTitle,
    cardTaskId,
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
  import AgentPlanDecision from "./AgentPlanDecision.svelte";
  import AgentRequestCard from "./AgentRequestCard.svelte";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import { conversationIsVisible } from "../lib/conversation-visibility";

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
  let now = $state(Date.now());
  const cardState = $derived(agentConversationCardState(ref));
  const live = $derived(isLiveAgentConversationState(cardState));
  // Reloaded transcripts default the provider; the index knows the truth.
  const provider = $derived(meta?.provider ?? ref.provider);
  const agentName = $derived(agentLabel(provider));
  const title = $derived(agentConversationTitle(ref, meta));
  const provenance = $derived(
    provenanceLine(ref, meta, hostLabelFor(serverId)),
  );

  const onScreen = conversationIsVisible();
  $effect(() => {
    if (!live || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const elapsed = $derived(
    formatAgentConversationDuration(agentConversationElapsedMs(ref, now)),
  );
  // What the other agent's turn waits on a person for; answered right here.
  const request = $derived(cardState === "waiting" ? pendingRequest(ref) : null);
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
        openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
      },
      options,
    );
  }

  function stop() {
    void api.stopSession(ref.agentSessionId);
  }

  const link = $derived(agentConversationLink(ref, cardState, neverStarted));
  let menuOpen = $state(false);

  async function copySessionId() {
    menuOpen = false;
    await copyText(ref.agentSessionId);
    toasts.success("Session ID copied");
  }

  function handleMenuCloseAutoFocus(event: Event) {
    event.preventDefault();
    requestInputFocus();
  }
</script>

<!-- Colour is identity for the other agent while the exchange is live; the
     request and plan blocks below read the same variable. -->
<div
  class="py-1 {skipMotion ? '' : 'animate-msg-in-side'}"
  style:--agent-accent={live ? agentAccent(accentIndex) : "var(--muted-foreground)"}
>
  <!-- The transcript card's surface: its fill, radius, and quiet ring. -->
  <div
    class="rounded-(--tx-card-radius) bg-(--solus-tx-card-bg) p-1 shadow-[shadow:var(--solus-tx-quiet-shadow)]"
  >
    <AgentLinkRow
      {provider}
      tone={link.tone}
      {title}
      status={link.label}
      detail={link.detail}
      {elapsed}
      hint={provenance || undefined}
      ariaLabel="Open {agentName} session: {title}"
      data-testid="agent-conversation-card"
      data-state={cardState}
      onOpen={neverStarted ? undefined : () => open()}
      onOpenSecondary={neverStarted ? undefined : () => open({ split: true })}
      trailing={neverStarted ? undefined : rowActions}
    />
    {#if needsDecision}
      <!-- Indented to the title: px-2, the 24px avatar, and the 10px gap. -->
      <!-- A click in the answer must not open the session. -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="cursor-auto pt-1 pr-2 pb-1 pl-[2.625rem] text-transcript-meta"
        onclick={(e) => e.stopPropagation()}
      >
        {#if planToDecide}
          <div class="pb-0.5">
            <AgentPlanDecision {tabId} targetAgentSessionId={ref.agentSessionId} />
          </div>
        {/if}
        {#if request}
          <AgentRequestCard {ref} {request} {tabId} />
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- The split and ⋯ stay out of the way until the row is hovered or focused;
     on touch, where nothing hovers, they always show. -->
{#snippet rowActions()}
  <span
    class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/agent:opacity-100 group-hover/agent:opacity-100 pointer-coarse:opacity-100 {menuOpen
      ? 'opacity-100'
      : ''}"
  >
    <TranscriptCardAction
      kind="icon"
      label="Open {agentName} beside this conversation"
      onclick={() => open({ split: true })}
    >
      <PanelRightIcon size={14} strokeWidth={1.75} />
    </TranscriptCardAction>
    <Popover.Root bind:open={menuOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <button
            {...mergeProps(props, {
              onclick: (e: MouseEvent) => e.stopPropagation(),
            })}
            type="button"
            class="tx-card-action is-icon"
            aria-label="More actions"
            title="More actions"
          >
            <EllipsisIcon size={14} strokeWidth={2.5} />
          </button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={6}
        class="w-auto min-w-44 gap-0.5 p-1"
        onCloseAutoFocus={handleMenuCloseAutoFocus}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="flex flex-col gap-0.5" onclick={(e) => e.stopPropagation()}>
          {@render cardMenu()}
        </div>
      </Popover.Content>
    </Popover.Root>
  </span>
{/snippet}

{#snippet cardMenu()}
  <!-- Provenance on demand: none of it earns space on the card. A local
       session on an unknown model has nothing to say here. -->
  {#if provenance}
    <div class="text-transcript-meta max-w-60 px-2.5 pt-1 pb-2 break-words text-(--solus-text-tertiary)">
      {provenance}
    </div>
  {/if}
  {#if taskId}
    <TranscriptCardAction kind="item" onclick={() => session.goToTask(taskId, "click")}>
      Open its task
    </TranscriptCardAction>
  {/if}
  <TranscriptCardAction kind="item" onclick={() => void copySessionId()}>
    Copy session ID
  </TranscriptCardAction>
  {#if live && cardState !== "waiting"}
    <TranscriptCardAction kind="item" destructive onclick={stop}>
      Stop {agentName}
    </TranscriptCardAction>
  {/if}
{/snippet}
