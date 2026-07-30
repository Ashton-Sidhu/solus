<script lang="ts">
  import { ArrowUpRightIcon } from "phosphor-svelte";
  import type { RelayExchange } from "../../../../shared/types";
  import { exchangeDurationMs, formatRelayDuration } from "./lib/relay";

  interface Props {
    exchange: RelayExchange;
    now: number;
    /** Peer display name for the live shimmer ("Codex is writing a reply"). */
    agentName: string;
    /** True only for the card's active last exchange — gates the shimmer, so a
     *  reconstructed exchange whose settle was lost reads as a quiet fact. */
    pendingLive?: boolean;
    onInterrupt?: () => void;
  }
  let { exchange, now, agentName, pendingLive = false, onInterrupt }: Props = $props();

  let promptExpanded = $state(false);
  const promptIsLong = $derived(exchange.prompt.length > 140);
  const duration = $derived(exchangeDurationMs(exchange, now));
  const isPending = $derived(
    exchange.status === "dispatched" || exchange.status === "awaiting_input",
  );
</script>

<div class="grid grid-cols-[22px_minmax(0,1fr)_40px] gap-x-3 py-3">
  <div class="font-mono text-[10.5px] pt-[3px] text-muted-foreground/45 tabular-nums">
    {String(exchange.index).padStart(2, "0")}
  </div>

  <div class="min-w-0">
    {#if exchange.prompt}
      <div class="flex items-baseline gap-2 mb-2 min-w-0">
        <ArrowUpRightIcon
          size={10}
          class="shrink-0 text-muted-foreground/50 self-center"
        />
        <span
          class="text-[13px] text-muted-foreground min-w-0 {promptExpanded
            ? 'whitespace-pre-wrap'
            : 'truncate'}"
        >
          {exchange.prompt}
        </span>
        {#if promptIsLong}
          <button
            class="shrink-0 text-[11px] text-muted-foreground/55 hover:text-muted-foreground cursor-pointer"
            onclick={() => (promptExpanded = !promptExpanded)}
          >
            {promptExpanded ? "collapse" : "full prompt"}
          </button>
        {/if}
      </div>
    {/if}

    {#if exchange.reply}
      <p class="text-[14px] leading-[1.62] whitespace-pre-wrap text-pretty m-0">
        {exchange.reply}
      </p>
      {#if exchange.toolCallCount}
        <div class="mt-2 font-mono text-[11px] text-muted-foreground/65 tabular-nums">
          {exchange.toolCallCount}
          {exchange.toolCallCount === 1 ? "tool call" : "tool calls"}
        </div>
      {/if}
    {:else if exchange.status === "awaiting_input" && exchange.question}
      <div
        class="rounded-lg px-3 py-2 text-[13.5px] leading-[1.55] text-pretty bg-[color-mix(in_oklch,var(--solus-status-permission)_10%,transparent)]"
      >
        {exchange.question.text}
      </div>
    {:else if isPending && pendingLive}
      <div class="flex items-center gap-2.5">
        <span class="relay-shimmer text-[14px]">{agentName} is writing a reply</span>
        <span class="flex-1"></span>
        {#if onInterrupt}
          <button
            class="rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)] hover:text-(--destructive)"
            onclick={onInterrupt}
          >
            Interrupt
          </button>
        {/if}
      </div>
    {:else if isPending}
      <div class="text-[13px] text-muted-foreground/70">no reply recorded — open the session to catch up</div>
    {:else if exchange.status === "failed"}
      <div class="text-[13px] text-(--destructive)">no reply — the run failed</div>
    {:else if exchange.status === "interrupted"}
      <div class="text-[13px] text-muted-foreground/70">interrupted before a reply landed</div>
    {/if}
  </div>

  <div
    class="font-mono text-[10.5px] pt-[3px] text-right text-muted-foreground/60 tabular-nums"
  >
    {duration != null ? formatRelayDuration(duration) : ""}
  </div>
</div>

<style>
  @keyframes relay-shim {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -100% 0;
    }
  }
  .relay-shimmer {
    background: linear-gradient(
      90deg,
      var(--muted-foreground) 30%,
      var(--foreground) 50%,
      var(--muted-foreground) 70%
    );
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: relay-shim 2.4s linear infinite;
  }
</style>
