<script lang="ts">
  /** The deliveries of one webhook, newest first, with an outcome filter, and
   *  the detail of one delivery: its request and one row for each action
   *  (docs/plans/webhooks.md §3.3). Replay runs a stored delivery again. */
  import { untrack } from "svelte";
  import { RotateCcw as ReplayIcon } from "@lucide/svelte";
  import type { Webhook, WebhookDelivery } from "@solus/contracts/webhooks";
  import { getWorkspaceContext } from "../../contexts";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { relativeTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import WebhookActionResults from "./WebhookActionResults.svelte";
  import { isFailingOutcome, outcomeLabel, OUTCOME_FILTERS, type WebhookOutcomeFilter } from "./lib/webhooks-view";
  import { deliveryMatches, lostRequestsText, sourceLabel, verificationFailureText } from "./lib/webhook-deliveries";

  let { serverId, webhook, canReplay }: { serverId: string; webhook: Webhook; canReplay: boolean } = $props();

  const session = getWorkspaceContext();
  let outcome = $state<"" | WebhookOutcomeFilter>("");
  let openDeliveryId = $state<string | null>(null);
  let openDelivery = $state<WebhookDelivery | null>(null);
  let loadError = $state("");
  let isReplaying = $state(false);

  $effect(() => {
    const hostId = serverId;
    const webhookId = webhook.id;
    untrack(() => {
      webhooksStore.loadDeliveries(hostId, webhookId).catch(() => (loadError = "Could not load the deliveries."));
    });
  });

  const deliveries = $derived(webhooksStore.deliveriesFor(serverId, webhook.id));
  const shown = $derived((deliveries ?? []).filter((delivery) => deliveryMatches(delivery.outcome, outcome)));
  const outcomeChoices: { value: "" | WebhookOutcomeFilter; label: string }[] = [
    { value: "", label: "All" },
    ...OUTCOME_FILTERS.filter((choice) => choice !== "never").map((choice) => ({ value: choice, label: outcomeLabel(choice) })),
  ];

  async function toggle(deliveryId: string) {
    if (openDeliveryId === deliveryId) {
      openDeliveryId = null;
      openDelivery = null;
      return;
    }
    openDeliveryId = deliveryId;
    openDelivery = null;
    const delivery = await webhooksStore.readDelivery(serverId, webhook.id, deliveryId).catch(() => null);
    if (openDeliveryId === deliveryId) openDelivery = delivery;
  }

  async function replay(deliveryId: string, actionId?: string) {
    if (isReplaying) return;
    isReplaying = true;
    try {
      await webhooksStore.replay(serverId, webhook.id, deliveryId, actionId);
      toasts.success(actionId ? "Replayed the action." : "Replayed the delivery.");
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Could not replay the delivery.");
    } finally {
      isReplaying = false;
    }
  }

  function openSession(sessionId: string) {
    session.router.close("settings");
    void session.revealSession(sessionId, serverId);
  }
</script>

<section class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="text-base font-medium">Deliveries</h3>
    <span class="ml-auto text-workspace-chrome text-muted-foreground">Outcome</span>
    <SettingsSelect compact ariaLabel="Delivery outcome" options={outcomeChoices} value={outcome} onSelect={(next) => (outcome = next)} />
  </div>
  {#if webhook.lostCount > 0}
    <p class="text-sm text-destructive">{lostRequestsText(webhook.lostCount)}</p>
  {/if}
  {#if loadError}
    <p class="text-sm text-destructive">{loadError}</p>
  {:else if !deliveries}
    <p class="text-sm text-muted-foreground">Loading deliveries…</p>
  {:else if shown.length === 0}
    <p class="text-sm text-muted-foreground">{deliveries.length === 0 ? "No deliveries yet." : "No deliveries have this outcome."}</p>
  {:else}
    <ul class="flex flex-col divide-y divide-border/50 rounded-xl border border-border/50">
      {#each shown as delivery (delivery.id)}
        <li class="flex flex-col">
          <button
            type="button"
            class="flex w-full min-w-0 cursor-pointer items-center gap-3 overflow-hidden px-4 py-2.5 text-left text-sm hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-1)] focus-visible:outline-none"
            aria-expanded={openDeliveryId === delivery.id}
            onclick={() => void toggle(delivery.id)}
          >
            <span class="w-28 shrink-0 {isFailingOutcome(delivery.outcome) ? 'text-destructive' : ''}">{outcomeLabel(delivery.outcome)}</span>
            <span class="shrink-0 text-muted-foreground">{relativeTime(delivery.receivedAt)}</span>
            <span class="shrink-0 text-muted-foreground">{sourceLabel(delivery.source)}{delivery.replayOf ? " · Replay" : ""}</span>
            {#if delivery.reason}<span class="min-w-0 truncate text-muted-foreground">{delivery.reason}</span>{/if}
          </button>
          {#if openDeliveryId === delivery.id}
            <div class="flex flex-col gap-3 border-t border-border/50 px-4 py-3 text-sm">
              {#if !openDelivery}
                <p class="text-muted-foreground">Loading the delivery…</p>
              {:else}
                <p class="text-muted-foreground">
                  Received {new Date(openDelivery.receivedAt).toLocaleString()}. Arrived {new Date(openDelivery.arrivedAt).toLocaleString()}. Method {openDelivery.request.method}.
                </p>
                {#if openDelivery.verificationFailure}
                  <p class="text-destructive">{verificationFailureText(openDelivery.verificationFailure)}</p>
                {/if}
                {#if canReplay}
                  <Button size="xs" variant="outline" class="self-start" disabled={isReplaying} onclick={() => void replay(delivery.id)}>
                    <ReplayIcon size={14} /> Replay all actions
                  </Button>
                {/if}
                <WebhookActionResults
                  results={openDelivery.actions}
                  onOpenSession={openSession}
                  onReplay={canReplay ? (actionId) => void replay(delivery.id, actionId) : undefined}
                />
                <details>
                  <summary class="cursor-pointer text-muted-foreground">Request</summary>
                  <div class="mt-2 flex flex-col gap-2">
                    <h4 class="text-xs text-muted-foreground">Headers</h4>
                    <pre class="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{openDelivery.request.headers.map(([name, value]) => `${name}: ${value}`).join("\n") || "None"}</pre>
                    <h4 class="text-xs text-muted-foreground">Query</h4>
                    <pre class="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs">{openDelivery.request.query.map(([name, value]) => `${name}=${value}`).join("\n") || "None"}</pre>
                    <h4 class="text-xs text-muted-foreground">Body{openDelivery.request.bodyIsBase64 ? " (base64: it is not text)" : ""}</h4>
                    <pre class="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{openDelivery.request.body}</pre>
                  </div>
                </details>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
