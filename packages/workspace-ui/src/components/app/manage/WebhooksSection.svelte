<script lang="ts">
  import { untrack } from "svelte";
  import { Play as SendIcon, RotateCcw as ReplayIcon } from "@lucide/svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import type { WebhookDelivery } from "@solus/contracts/webhooks";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { webhooksStore } from "../../../contexts/webhooks/webhooks.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import CodeBlock from "../../ui/CodeBlock.svelte";
  import CopyButton from "../../ui/CopyButton.svelte";
  import * as Tabs from "../../ui/tabs";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import { REACHABILITY_TEXT } from "../../webhooks/lib/webhook-reachability";
  import ManageSectionState from "./ManageSectionState.svelte";
  import {
    answerStatus,
    answerText,
    bodyView,
    callText,
    deliverySubtitle,
    deliveryTime,
    deliveryTitle,
    headerRows,
    isFailedDelivery,
    isRefused,
    isTestDelivery,
    maskedSecret,
    refusalText,
    webhookSummaryText,
  } from "./lib/app-webhook-deliveries";

  /**
   * The webhooks the active version declares (docs/plans/apps.md §9.2). The
   * head gives the URL and the signing secret to copy into the other service.
   * Under it, the deliveries the receiver kept, and the request, the answer,
   * and the mutation call of the one chosen. Send test signs a request with
   * the stored secret; Replay sends a stored one through the same path again.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  /** The page the webhooks store reads: the week's count says "200+" when it is full. */
  const DELIVERY_PAGE = 200;

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseWebhooks = appsStore.webhooks.watch(hostId, appId);
      // The webhook owner's events keep the deliveries fresh.
      const releaseOwner = webhooksStore.watch();
      return () => {
        releaseWebhooks();
        releaseOwner();
      };
    });
  });
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id));

  let chosenName = $state<string | null>(null);
  const webhook = $derived(webhooks?.find((entry) => entry.name === chosenName) ?? webhooks?.[0]);
  const webhookId = $derived(webhook?.webhookId ?? null);
  const verification = $derived(webhookId ? webhooksStore.get(serverId, webhookId)?.webhook.verification : undefined);

  let deliveriesError = $state<string | null>(null);
  $effect(() => {
    const hostId = serverId;
    const id = webhookId;
    if (!id) return;
    untrack(() => {
      deliveriesError = null;
      webhooksStore.loadDeliveries(hostId, id).catch((error) => (deliveriesError = error instanceof Error ? error.message : "The host did not answer."));
    });
  });
  const deliveries = $derived(webhookId ? webhooksStore.deliveriesFor(serverId, webhookId) : undefined);

  let chosenDeliveryId = $state<string | null>(null);
  const selected = $derived(deliveries?.find((delivery) => delivery.id === chosenDeliveryId) ?? deliveries?.[0]);

  // One delivery with its request: read when it is chosen, and again when its actions end.
  let detail = $state<WebhookDelivery | null>(null);
  let detailError = $state<string | null>(null);
  $effect(() => {
    const hostId = serverId;
    const id = webhookId;
    const deliveryId = selected?.id;
    void selected?.outcome;
    if (!id || !deliveryId) {
      detail = null;
      return;
    }
    let isCurrent = true;
    untrack(() => {
      detailError = null;
      if (detail?.id !== deliveryId) detail = null;
      webhooksStore.readDelivery(hostId, id, deliveryId)
        .then((read) => { if (isCurrent) detail = read; })
        .catch((error) => { if (isCurrent) detailError = error instanceof Error ? error.message : "The host did not answer."; });
    });
    return () => { isCurrent = false; };
  });

  let tab = $state<"request" | "response" | "call">("request");
  let isBusy = $state(false);
  let deliveryList = $state<HTMLElement | null>(null);

  async function act(run: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await run();
    } catch (cause) {
      toasts.error(failure, { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isBusy = false;
    }
  }

  function sendTest(id: string) {
    void act(async () => {
      const sent = await webhooksStore.sendTest(serverId, id);
      chosenDeliveryId = sent.id;
      toasts.success("Sent a test delivery.");
    }, "The test was not sent");
  }

  function replay(id: string, deliveryId: string) {
    void act(async () => {
      await webhooksStore.replay(serverId, id, deliveryId);
      chosenDeliveryId = webhooksStore.deliveriesFor(serverId, id)?.[0]?.id ?? deliveryId;
      toasts.success("Replayed the delivery.");
    }, "The delivery was not replayed");
  }

  function rotate(name: string) {
    if (!confirm("Make a new signing secret? Requests signed with the old one fail until the sender has the new one.")) return;
    void act(() => appsStore.rotateWebhookSecret(serverId, app.id, name), "The signing secret was not changed");
  }

  /** Up and Down move through the deliveries, as in a list of rows. */
  function moveSelection(event: KeyboardEvent) {
    if (!deliveries?.length || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const index = deliveries.findIndex((delivery) => delivery.id === selected?.id);
    const next = deliveries[Math.min(deliveries.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    chosenDeliveryId = next.id;
    deliveryList?.querySelector<HTMLElement>(`[data-delivery-id="${next.id}"]`)?.focus();
  }
</script>

<ManageSectionState
  count={webhooks?.length}
  error={appsStore.webhooks.errorFor(serverId, app.id)}
  empty="This app declares no webhook."
  onRetry={() => void appsStore.webhooks.load(serverId, app.id)}
>
  {#if webhook}
    <div class="flex min-w-0 flex-col gap-4" data-testid="app-webhooks">
      <header class="flex min-w-0 flex-col gap-2.5 px-1 pt-0.5 pb-1">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          {#if webhooks && webhooks.length > 1}
            <SettingsSelect compact ariaLabel="Webhook" options={webhooks.map((entry) => ({ value: entry.name, label: entry.name }))} value={webhook.name} onSelect={(name) => { chosenName = name; chosenDeliveryId = null; }} />
          {:else}
            <h3 class="m-0 min-w-0 truncate text-lg leading-5.5 font-semibold text-foreground">{webhook.name}</h3>
          {/if}
          <span class="min-w-0 truncate text-[13px] text-muted-foreground">
            {webhookSummaryText(webhook.run, deliveries, DELIVERY_PAGE)}{webhook.enabled ? "" : " · Paused"}
          </span>
          <span class="flex-1"></span>
          {#if webhook.webhookId}
            {@const id = webhook.webhookId}
            <Button size="sm" variant="outline" class="shrink-0 rounded-full text-workspace-chrome" disabled={isBusy || !webhook.enabled} onclick={() => sendTest(id)}>
              <SendIcon class="size-3" /> Send test
            </Button>
          {/if}
        </div>

        {#if webhook.problem}
          <p class="m-0 text-[13px] text-(--failure) text-pretty" role="alert">{webhook.problem}</p>
        {/if}
        <div class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-2">
          {#if webhook.url}
            <span class="shrink-0 rounded-sm bg-(--wash-2) px-1.75 py-1 text-[11px] leading-3.5 font-semibold tracking-[0.04em] text-(--solus-text-secondary)">POST</span>
            <span class="min-w-0 truncate font-mono text-[13px] text-foreground select-text" title={webhook.url}>{webhook.url}</span>
            <CopyButton text={webhook.url} title="Copy the URL" iconOnly />
          {:else if webhook.webhookId}
            <span class="min-w-0 text-[13px] text-muted-foreground text-pretty">{REACHABILITY_TEXT.noUrl}</span>
          {/if}
          <span class="flex-1"></span>
          {#if webhook.secret !== null}
            <!-- A credential: the screen shows its end only; the value goes to the clipboard. -->
            <span class="shrink-0 text-[13px] text-muted-foreground">Signing secret</span>
            <span class="shrink-0 font-mono text-xs text-(--solus-text-secondary)">{maskedSecret(webhook.secret)}</span>
            <CopyButton text={webhook.secret} title="Copy the signing secret" iconOnly />
            <Button size="xs" variant="link" class="h-auto px-0 text-[13px] text-muted-foreground" disabled={isBusy} onclick={() => rotate(webhook.name)}>Rotate</Button>
          {/if}
        </div>
      </header>

      {#if webhook.webhookId}
        {@const id = webhook.webhookId}
        <div class="flex min-w-0 items-start gap-6 @max-[48rem]/pane:flex-col">
          <section class="flex w-72.5 shrink-0 flex-col gap-0.5 @max-[48rem]/pane:w-full" aria-label="Deliveries">
            <div class="flex h-9 shrink-0 items-center justify-between px-3 pb-1.5">
              <h4 class="m-0 text-[15px] leading-4.5 font-semibold text-foreground">Deliveries</h4>
              <span class="text-[13px] text-muted-foreground">Newest first</span>
            </div>
            {#if deliveries === undefined}
              {#if deliveriesError}
                <div class="flex flex-wrap items-center gap-2 px-3" role="alert">
                  <span class="text-[13px] text-destructive">{deliveriesError}</span>
                  <Button size="xs" variant="outline" onclick={() => void webhooksStore.loadDeliveries(serverId, id).catch(() => {})}>Try again</Button>
                </div>
              {:else}
                <p class="m-0 px-3 text-[13px] text-muted-foreground" role="status" aria-busy="true">Loading…</p>
              {/if}
            {:else if deliveries.length === 0}
              <p class="m-0 px-3 text-[13px] text-muted-foreground text-pretty">No delivery came yet. Send a test to see one here.</p>
            {:else}
              <div bind:this={deliveryList} class="flex flex-col gap-0.5" role="listbox" aria-label="Deliveries" tabindex="-1" onkeydown={moveSelection}>
                {#each deliveries as delivery (delivery.id)}
                  {@const isSelected = delivery.id === selected?.id}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-delivery-id={delivery.id}
                    tabindex={isSelected ? 0 : -1}
                    class="flex min-w-0 items-center gap-3 overflow-hidden rounded-[10px] px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 {isSelected ? 'bg-(--wash-2)' : 'hover:bg-(--wash-1)'}"
                    onclick={() => (chosenDeliveryId = delivery.id)}
                  >
                    <span class="w-7.5 shrink-0 text-[13px] font-semibold tabular-nums {isFailedDelivery(delivery.outcome) ? 'text-(--failure)' : 'text-(--success)'}">{answerStatus(delivery.outcome)}</span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="truncate text-sm leading-4.5 text-foreground {isSelected ? 'font-medium' : ''}">{deliveryTitle(delivery, webhook.run)}</span>
                      <span class="truncate text-xs text-muted-foreground">{deliverySubtitle(delivery)}</span>
                    </span>
                    <span class="shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(delivery.arrivedAt).toLocaleString()}>{deliveryTime(delivery.arrivedAt)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>

          {#if selected}
            <section class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background pb-2 shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] dark:bg-card dark:shadow-none @max-[48rem]/pane:w-full" aria-label="The chosen delivery" data-testid="app-webhook-delivery">
              <Tabs.Root bind:value={() => tab, (next) => (tab = next === "response" || next === "call" ? next : "request")}>
                <div class="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
                  <Tabs.List>
                    <Tabs.Trigger value="request" class="px-2.5 text-[13px]">Request</Tabs.Trigger>
                    <Tabs.Trigger value="response" class="px-2.5 text-[13px]">Response</Tabs.Trigger>
                    <Tabs.Trigger value="call" class="px-2.5 text-[13px]">Call</Tabs.Trigger>
                  </Tabs.List>
                  <Button size="sm" variant="outline" class="rounded-full text-[13px]" disabled={isBusy || !webhook.enabled || selected.outcome === "pending"} onclick={() => replay(id, selected.id)}>
                    <ReplayIcon class="size-3" /> Replay
                  </Button>
                </div>

                {#if detail && detail.id === selected.id}
                  {@const call = detail.actions[0]}
                  <Tabs.Content value="request" class="flex flex-col">
                    {@const body = bodyView(detail.request)}
                    {#if isTestDelivery(detail)}
                      <p class="m-0 px-5 pt-3.5 text-[13px] text-muted-foreground">A test delivery that Send test made.</p>
                    {/if}
                    <div class="flex flex-col px-5 pt-3.5 pb-1.5">
                      <h5 class="m-0 pb-1.5 text-[13px] font-semibold text-foreground">Headers</h5>
                      {#each headerRows(detail, verification) as header (header.name)}
                        <div class="flex min-h-7.5 min-w-0 items-center gap-2 border-t border-(--hairline) py-1 last:border-b">
                          <span class="w-50 shrink-0 truncate font-mono text-xs text-muted-foreground @max-[30rem]/pane:w-32">{header.name}</span>
                          <span class="min-w-0 truncate font-mono text-xs text-foreground select-text" title={header.value}>{header.value}</span>
                          {#if header.check === "valid"}
                            <span class="shrink-0 text-xs text-(--success)">Valid</span>
                          {:else if header.check === "invalid"}
                            <span class="shrink-0 text-xs text-(--failure)">Not valid</span>
                          {/if}
                        </div>
                      {/each}
                    </div>
                    <div class="flex flex-col gap-2 px-5 pt-3 pb-5">
                      <h5 class="m-0 text-[13px] font-semibold text-foreground">Body</h5>
                      <CodeBlock text={body.text} lang={body.lang} showHeader={false} />
                      <p class="m-0 pt-1 text-[13px] text-muted-foreground text-pretty">{callText(call, webhook.run)}</p>
                    </div>
                  </Tabs.Content>
                  <Tabs.Content value="response" class="flex flex-col gap-2 px-5 pt-3.5 pb-5">
                    {@const answer = answerText(detail)}
                    <p class="m-0 text-[13px] text-foreground"><span class="font-semibold tabular-nums {isRefused(detail.outcome) ? 'text-(--failure)' : 'text-(--success)'}">{answer.status}</span> {isRefused(detail.outcome) ? "Refused" : "Accepted"}</p>
                    {#if refusalText(detail)}
                      <p class="m-0 text-[13px] text-(--failure) text-pretty">{refusalText(detail)}</p>
                    {/if}
                    <CodeBlock text={answer.body} lang="json" showHeader={false} />
                  </Tabs.Content>
                  <Tabs.Content value="call" class="flex flex-col gap-2 px-5 pt-3.5 pb-5">
                    <p class="m-0 text-[13px] text-pretty {call?.status === 'failed' || call?.status === 'busy' ? 'text-(--failure)' : 'text-foreground'}">{callText(call, webhook.run)}</p>
                    {#if call}
                      <p class="m-0 text-xs text-muted-foreground">The mutation ran with the request's headers, query, and body as its input. Activity lists the call with its logs.</p>
                    {/if}
                  </Tabs.Content>
                {:else if detailError}
                  <p class="m-0 px-5 py-4 text-[13px] text-destructive" role="alert">{detailError}</p>
                {:else}
                  <p class="m-0 px-5 py-4 text-[13px] text-muted-foreground" role="status" aria-busy="true">Loading…</p>
                {/if}
              </Tabs.Root>
            </section>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</ManageSectionState>
