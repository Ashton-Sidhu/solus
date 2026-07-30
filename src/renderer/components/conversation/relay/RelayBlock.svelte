<script lang="ts">
  import { CaretRightIcon, CheckIcon, DotsThreeIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import type { RelayRef } from "../../../../shared/types";
  import { getWorkspaceContext } from "../../../contexts";
  import { agentLabel } from "../../../lib/agentAvailability";
  import { resolveSessionLinkMeta } from "../lib/session-link";
  import {
    agentMonogram,
    foldExchanges,
    foldTopics,
    formatRelayDuration,
    hostLabelFor,
    isLiveRelayState,
    provenanceLine,
    relayCardState,
    relayElapsedMs,
    relayStateLabel,
    relayTitle,
  } from "./lib/relay";
  import { relayStatus } from "./relay-status.store.svelte";
  import RelayComposer from "./RelayComposer.svelte";
  import RelayExchangeRow from "./RelayExchangeRow.svelte";

  /**
   * One relay card per peer session per turn (design: Session Orchestration).
   * The exchange — sent prompt + peer reply — is the unit; the header is one
   * band with four slots (who · about · state · actions) that never reflows
   * across states. Only honest numbers appear: exchanges and elapsed.
   */
  interface Props {
    ref: RelayRef;
    tabId: string;
    skipMotion?: boolean;
  }
  let { ref, tabId, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();

  $effect(() => {
    relayStatus.track(ref.peerSessionId);
  });

  const meta = $derived(relayStatus.metaFor(ref.peerSessionId));
  const peerStatus = $derived(relayStatus.statusFor(ref.peerSessionId));
  let now = $state(Date.now());
  const state = $derived(relayCardState(ref, peerStatus, now));
  const live = $derived(isLiveRelayState(state));
  // Reloaded transcripts default the provider; the index knows the truth.
  const provider = $derived(meta?.provider ?? ref.provider);
  const agentName = $derived(agentLabel(provider));
  const title = $derived(relayTitle(ref, meta));
  const serverId = $derived(session.sessionFor(tabId)?.serverId);
  const provenance = $derived(provenanceLine(ref, meta, hostLabelFor(serverId)));

  $effect(() => {
    if (!live) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const elapsed = $derived(formatRelayDuration(relayElapsedMs(ref, now)));
  const fold = $derived(foldExchanges(ref.exchanges, !live));
  // The reader can pull folded exchanges back; live updates never push them out
  // again mid-read (one-way until the card settles and re-folds).
  let foldOpenByUser = $state(false);
  const visibleExchanges = $derived(foldOpenByUser ? ref.exchanges : fold.open);
  const lastExchange = $derived(ref.exchanges[ref.exchanges.length - 1]);
  const waitingQuestion = $derived(
    state === "waiting" ? lastExchange?.question?.text : undefined,
  );

  async function open() {
    const linkMeta = await resolveSessionLinkMeta({
      provider,
      sessionId: ref.peerSessionId,
      cwd: ref.cwd,
    });
    await session.resumeSession(linkMeta);
  }

  function interrupt() {
    void window.solus.stopSession(ref.peerSessionId);
  }

  function retry() {
    if (!lastExchange?.prompt) return void open();
    void window.solus.promptSession(ref.peerSessionId, lastExchange.prompt, "queue");
  }

  function copyId() {
    void navigator.clipboard.writeText(ref.peerSessionId);
  }

  const cardRing = $derived(
    state === "waiting"
      ? "shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--solus-status-permission)_45%,transparent),0_1px_2px_-1px_rgba(0,0,0,0.06)]"
      : state === "failed"
        ? "shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--destructive)_40%,transparent)]"
        : "shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_12%,transparent),0_1px_2px_-1px_rgba(0,0,0,0.06)]",
  );
</script>

<div
  class="my-2 bg-card rounded-xl overflow-hidden {cardRing} {skipMotion ? '' : 'animate-msg-in-side'}"
  data-testid="relay-block"
>
  <!-- Header — one band, four slots: who · about · state · actions. -->
  <div
    class="flex items-center gap-2.5 px-3.5 py-2.5 border-b-[0.5px] border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] {state === 'closed' ? 'opacity-70' : ''}"
  >
    <span
      class="flex items-center justify-center size-[21px] rounded-md font-mono font-medium text-[10px] shrink-0 {live
        ? 'bg-[color-mix(in_oklch,var(--primary)_13%,transparent)] text-[color-mix(in_oklch,var(--primary)_78%,var(--foreground))]'
        : 'bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] text-muted-foreground'}"
    >
      {agentMonogram(provider)}
    </span>
    <span class="font-semibold text-[13px] tracking-[-0.008em] shrink-0">{agentName}</span>
    <span class="text-[12.5px] text-muted-foreground truncate min-w-0">“{title}”</span>
    <span class="flex-1"></span>

    {#if state === "replying"}
      <span class="relay-pulse-dot size-1.5 rounded-full shrink-0 bg-(--primary)"></span>
      <span class="text-[12px] font-medium shrink-0">Replying</span>
      <span class="font-mono text-[11px] text-muted-foreground/70 tabular-nums shrink-0">{elapsed}</span>
    {:else if state === "dispatching"}
      <span class="font-mono text-[11px] text-muted-foreground/70 shrink-0">dispatching</span>
    {:else if state === "waiting"}
      <span class="text-[12px] truncate max-w-[300px] shrink-0 text-[color-mix(in_oklch,var(--solus-status-permission)_74%,var(--foreground))]">
        {waitingQuestion ?? "waiting on you"}
      </span>
      <button
        class="rounded-md px-2.5 py-0.5 text-[11.5px] font-medium shrink-0 cursor-pointer bg-[color-mix(in_oklch,var(--solus-status-permission)_15%,transparent)] text-[color-mix(in_oklch,var(--solus-status-permission)_74%,var(--foreground))] hover:bg-[color-mix(in_oklch,var(--solus-status-permission)_22%,transparent)]"
        onclick={open}
      >
        Answer
      </button>
    {:else if state === "done"}
      <CheckIcon size={11} class="shrink-0 text-(--solus-status-complete)" />
      <span class="font-mono text-[11px] text-muted-foreground/70 tabular-nums shrink-0">
        {ref.exchanges.length}
        {ref.exchanges.length === 1 ? "exchange" : "exchanges"} · {elapsed}
      </span>
    {:else if state === "failed"}
      <span class="text-[12px] truncate shrink-0 text-(--destructive)">failed after {ref.exchanges.length === 1 ? "1 exchange" : `${ref.exchanges.length} exchanges`}</span>
      <button
        class="text-[11.5px] text-muted-foreground underline decoration-dotted underline-offset-3 shrink-0 cursor-pointer hover:text-foreground"
        onclick={retry}
      >
        Retry
      </button>
    {:else if state === "closed"}
      <span class="text-[12px] text-muted-foreground truncate shrink-0">closed by the other side</span>
      <span class="font-mono text-[11px] text-muted-foreground/70 shrink-0">transcript kept</span>
    {/if}

    <button
      class="rounded-md px-2 py-1 text-[11.5px] text-muted-foreground shrink-0 cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
      onclick={open}
    >
      Open
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="flex items-center justify-center size-6 rounded-md text-muted-foreground shrink-0 cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
        aria-label="Relay actions"
      >
        <DotsThreeIcon size={14} weight="bold" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {#if live}
          <DropdownMenu.Item onclick={interrupt}>Interrupt</DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item onclick={copyId}>Copy session id</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  <div class="px-3.5 pt-3">
    <!-- Provenance: host · worktree · model — a fact, stated once. -->
    <div class="font-mono text-[11px] text-muted-foreground/55 truncate mb-1">
      {provenance}
    </div>

    {#if fold.folded.length > 0 && !foldOpenByUser}
      <button
        class="flex items-center gap-2 w-full text-left text-[12px] text-muted-foreground py-2 cursor-pointer border-b-[0.5px] border-[color-mix(in_oklch,var(--foreground)_9%,transparent)] hover:text-foreground"
        onclick={() => (foldOpenByUser = true)}
      >
        <CaretRightIcon size={9} class="shrink-0" />
        <span class="shrink-0">
          {fold.folded.length} earlier {fold.folded.length === 1 ? "exchange" : "exchanges"}
        </span>
        <span class="truncate opacity-60">{foldTopics(fold.folded)}</span>
      </button>
    {/if}

    <div class="divide-y divide-[color-mix(in_oklch,var(--foreground)_9%,transparent)]">
      {#each visibleExchanges as exchange (exchange.exchangeId)}
        <RelayExchangeRow
          {exchange}
          {now}
          {agentName}
          pendingLive={exchange === lastExchange && live}
          onInterrupt={exchange === lastExchange && live ? interrupt : undefined}
        />
      {/each}
    </div>
  </div>

  <div
    class="flex items-center gap-2.5 px-3.5 py-2 border-t-[0.5px] border-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
  >
    {#if state !== "closed"}
      <RelayComposer peerSessionId={ref.peerSessionId} {agentName} busy={live} />
    {/if}
    <span class="flex-1"></span>
    <span class="font-mono text-[10.5px] text-muted-foreground/45 tabular-nums shrink-0">
      {ref.exchanges.length}
      {ref.exchanges.length === 1 ? "exchange" : "exchanges"}
    </span>
  </div>
</div>

<style>
  @keyframes relay-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  .relay-pulse-dot {
    animation: relay-pulse 1.6s ease-in-out infinite;
  }
</style>
