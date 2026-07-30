<script lang="ts">
  import { ArrowUpIcon, CheckIcon } from "phosphor-svelte";
  import type { Message } from "../../../../shared/types";
  import { formatRelayDuration, isLiveRelayState, relayCardState, relayElapsedMs } from "./lib/relay";
  import { relayStatus } from "./relay-status.store.svelte";
  import RelayBlock from "./RelayBlock.svelte";

  /**
   * The turn's relay cards, in dispatch order — never resorted; a peer needing
   * you is pulled forward only by colour weight (design §4a). Above two or more
   * peers sits a roster line that aggregates only what is countable: counts by
   * state, total exchanges, elapsed, and a broadcast composer.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  const refs = $derived(messages.flatMap((message) => (message.relayRef ? [message.relayRef] : [])));
  const isRoster = $derived(refs.length > 1);

  let now = $state(Date.now());
  const states = $derived(refs.map((ref) => relayCardState(ref, relayStatus.statusFor(ref.peerSessionId), now)));
  const anyLive = $derived(states.some(isLiveRelayState));

  $effect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const replyingCount = $derived(states.filter((state) => state === "replying" || state === "dispatching").length);
  const waitingCount = $derived(states.filter((state) => state === "waiting").length);
  const doneCount = $derived(states.filter((state) => state === "done").length);
  const totalExchanges = $derived(refs.reduce((sum, ref) => sum + ref.exchanges.length, 0));
  const totalElapsed = $derived(formatRelayDuration(Math.max(0, ...refs.map((ref) => relayElapsedMs(ref, now)))));

  let broadcastOpen = $state(false);
  let broadcastDraft = $state("");
  let broadcastSending = $state(false);

  async function broadcast() {
    const text = broadcastDraft.trim();
    if (!text || broadcastSending) return;
    broadcastSending = true;
    try {
      await Promise.allSettled(
        refs.map((ref) => window.solus.promptSession(ref.peerSessionId, text, "queue")),
      );
      broadcastDraft = "";
      broadcastOpen = false;
    } finally {
      broadcastSending = false;
    }
  }
</script>

{#if isRoster}
  <div class="flex items-center gap-2.5 px-0.5 pt-2 pb-1" data-testid="relay-roster">
    <span class="text-[12.5px] font-medium shrink-0">{refs.length} peer sessions</span>
    {#if replyingCount > 0}
      <span class="flex items-center gap-1.5 shrink-0">
        <span class="relay-pulse-dot size-1.5 rounded-full bg-(--primary)"></span>
        <span class="text-[12px] text-muted-foreground">{replyingCount} replying</span>
      </span>
    {/if}
    {#if waitingCount > 0}
      <span class="flex items-center gap-1.5 shrink-0">
        <span class="size-1.5 rounded-full bg-[color-mix(in_oklch,var(--solus-status-permission)_72%,var(--foreground))]"></span>
        <span class="text-[12px] text-muted-foreground">{waitingCount} waiting on you</span>
      </span>
    {/if}
    {#if doneCount > 0}
      <span class="flex items-center gap-1.5 shrink-0">
        <CheckIcon size={10} class="text-(--solus-status-complete)" />
        <span class="text-[12px] text-muted-foreground">{doneCount} done</span>
      </span>
    {/if}
    <span class="flex-1"></span>
    <span class="font-mono text-[11px] text-muted-foreground/60 tabular-nums shrink-0">
      {totalExchanges}
      {totalExchanges === 1 ? "exchange" : "exchanges"} · {totalElapsed}
    </span>
    {#if broadcastOpen}
      <input
        bind:value={broadcastDraft}
        class="w-56 bg-transparent text-[12px] outline-none border-b-[0.5px] border-[color-mix(in_oklch,var(--foreground)_20%,transparent)] placeholder:text-muted-foreground/60"
        placeholder="Ask all {refs.length}…"
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void broadcast();
          }
          if (e.key === "Escape") broadcastOpen = false;
        }}
      />
      <button
        class="flex items-center justify-center size-5.5 rounded-md shrink-0 cursor-pointer bg-primary text-primary-foreground hover:brightness-105 disabled:opacity-40"
        disabled={!broadcastDraft.trim() || broadcastSending}
        onclick={broadcast}
        aria-label="Send to all peers"
      >
        <ArrowUpIcon size={11} />
      </button>
    {:else}
      <button
        class="rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground shrink-0 cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
        onclick={() => (broadcastOpen = true)}
      >
        Ask all {refs.length}…
      </button>
    {/if}
  </div>
{/if}

<div class="flex flex-col gap-0">
  {#each messages as message (message.id)}
    {#if message.relayRef}
      <RelayBlock ref={message.relayRef} {tabId} {skipMotion} />
    {/if}
  {/each}
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
