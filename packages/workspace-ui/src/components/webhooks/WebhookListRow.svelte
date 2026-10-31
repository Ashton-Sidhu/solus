<script lang="ts">
  /** One webhook in a card of rows on Settings → Webhooks: a state tile, the
   *  name, where it lives and what it does in one muted line, then the last
   *  delivery and the count of the last 24 hours at the right end. Both the
   *  Hosts and the Organization views draw their webhooks with it. */
  import type { Snippet } from "svelte";
  import { ShieldAlert as ShieldAlertIcon, Webhook as WebhookIcon } from "@lucide/svelte";
  import { ListChip } from "../ui/list-page";
  import { relativeTime } from "../../lib/relative-time";

  interface Props {
    name: string;
    state: "active" | "paused" | "admin-paused";
    stateLabel: string;
    /** Where it lives and what it does, joined into one line. */
    details: string[];
    /** A muted note under the details, such as what happens while the host is offline. */
    note?: string | null;
    /** A warning under the details, such as a webhook that does not verify its sender. */
    warning?: string | null;
    lastDelivery: { label: string; isFailing: boolean; at: number } | null;
    deliveries24h: number;
    /** Opens the webhook. A row without it cannot be opened. */
    onOpen?: () => void;
    /** A control at the right end, such as Pause. */
    trailing?: Snippet;
  }

  let { name, state, stateLabel, details, note, warning, lastDelivery, deliveries24h, onOpen, trailing }: Props = $props();

  const tile = $derived(
    {
      active: "bg-[color-mix(in_oklch,var(--success)_15%,transparent)] text-[color-mix(in_oklch,var(--success)_70%,var(--foreground))]",
      paused: "bg-[var(--wash-3)] text-muted-foreground",
      "admin-paused": "bg-[color-mix(in_oklch,var(--warning)_17%,transparent)] text-[color-mix(in_oklch,var(--warning)_55%,var(--foreground))]",
    }[state],
  );
</script>

<div class="group relative flex items-center gap-3 px-4 py-3 transition-colors duration-150 {onOpen ? 'hover:bg-[var(--wash-1)] has-[button[data-open]:focus-visible]:bg-[var(--wash-1)]' : ''}">
  <span class="flex size-7 shrink-0 items-center justify-center self-start rounded-lg {tile}" title={stateLabel}>
    <WebhookIcon size={14} aria-hidden="true" />
  </span>

  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <div class="flex min-w-0 items-center gap-2">
      {#if onOpen}
        <!-- The name is the row's one button; its hit area covers the row. -->
        <button
          type="button"
          data-open
          class="min-w-0 cursor-pointer truncate text-left text-workspace-chrome font-medium text-foreground outline-none after:absolute after:inset-0 after:content-['']"
          onclick={onOpen}
        >
          {name}
        </button>
      {:else}
        <span class="min-w-0 truncate text-workspace-chrome font-medium text-foreground">{name}</span>
      {/if}
      {#if state !== "active"}
        <ListChip chip={{ label: stateLabel, tint: state === "admin-paused" ? "warning" : "neutral" }} />
      {/if}
    </div>
    <p class="truncate text-chrome-dense text-muted-foreground" title={details.join(" · ")}>{details.join(" · ")}</p>
    {#if note}<p class="text-xs text-muted-foreground opacity-80">{note}</p>{/if}
    {#if warning}
      <p class="flex items-start gap-1 text-xs text-destructive">
        <ShieldAlertIcon size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{warning}</span>
      </p>
    {/if}
  </div>

  <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
    {#if lastDelivery}
      <span class="flex items-center gap-1.5" title="Last delivery">
        <ListChip chip={{ label: lastDelivery.label, tint: lastDelivery.isFailing ? "failure" : "neutral" }} />
        <span class="tabular-nums">{relativeTime(lastDelivery.at)}</span>
      </span>
    {:else}
      <span class="opacity-80">No deliveries</span>
    {/if}
    <span class="w-14 text-right tabular-nums @max-[36rem]/pane:hidden" title="Deliveries in the last 24 hours">
      {deliveries24h} <span class="opacity-70">/ 24h</span>
    </span>
  </div>

  {#if trailing}<div class="relative shrink-0">{@render trailing()}</div>{/if}
</div>
