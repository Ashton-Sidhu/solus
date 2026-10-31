<script lang="ts">
  /** One webhook (docs/plans/webhooks.md §3.3, §4): its URL with Copy and Rotate,
   *  Pause and Resume, Delete, the editor, the deliveries, and the dry run. With
   *  a `new` target it is the editor for a new webhook. */
  import { untrack } from "svelte";
  import {
    ArrowLeft as ArrowLeftIcon,
    Copy as CopyIcon,
    RefreshCw as RotateIcon,
    ShieldAlert as ShieldAlertIcon,
  } from "@lucide/svelte";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import WebhookEditor from "./WebhookEditor.svelte";
  import WebhookDeliveries from "./WebhookDeliveries.svelte";
  import WebhookDryRun from "./WebhookDryRun.svelte";
  import { hostLabelFor, rowReachabilityText } from "./lib/webhook-host";
  import { REACHABILITY_TEXT, urlModeLabel } from "./lib/webhook-reachability";
  import { webhookState, webhookStateLabel, type WebhookOpenTarget } from "./lib/webhooks-view";
  import {
    createInputFromDraft,
    draftFromWebhook,
    newWebhookDraft,
    UNVERIFIED_WARNING,
    updateInputFromDraft,
    type WebhookDraft,
  } from "./lib/webhook-draft";

  let {
    target,
    defaultServerId,
    onClose,
    onOpen,
  }: {
    target: WebhookOpenTarget;
    /** The host filter of the page: a new webhook goes there unless the user picks another. */
    defaultServerId: string | null;
    onClose: () => void;
    onOpen: (target: WebhookOpenTarget) => void;
  } = $props();

  const connectedHosts = $derived(webhooksStore.hosts.filter((host) => host.connected));
  let chosenServerId = $state<string | null>(null);
  const serverId = $derived(
    target.kind === "webhook" ? target.serverId : (chosenServerId ?? target.serverId ?? defaultServerId ?? connectedHosts[0]?.serverId ?? null),
  );
  const row = $derived(target.kind === "webhook" ? webhooksStore.get(target.serverId, target.webhookId) : undefined);
  const webhook = $derived(row?.webhook);
  const url = $derived(target.kind === "webhook" ? webhooksStore.urlFor(target.serverId, target.webhookId) : null);
  const isOwner = $derived(target.kind === "new" || (target.kind === "webhook" && webhooksStore.isOwner(target.serverId, target.webhookId)));
  const status = $derived(webhook ? webhookState(webhook) : null);
  const reachability = $derived(row ? rowReachabilityText(row) : null);

  let draft = $state<WebhookDraft | null>(null);
  let readState = $state<"reading" | "read" | "missing" | "failed">("reading");
  let saveError = $state("");
  let isBusy = $state(false);

  $effect(() => {
    const current = target;
    untrack(() => {
      if (current.kind === "new") {
        draft = newWebhookDraft(null, crypto.randomUUID());
        readState = "read";
        return;
      }
      const known = webhooksStore.get(current.serverId, current.webhookId);
      if (known) draft = draftFromWebhook(known.webhook);
      webhooksStore
        .read(current.serverId, current.webhookId)
        .then(() => {
          const fresh = webhooksStore.get(current.serverId, current.webhookId);
          readState = fresh ? "read" : "missing";
          if (fresh && !draft) draft = draftFromWebhook(fresh.webhook);
        })
        .catch(() => (readState = known ? "read" : "failed"));
    });
  });

  async function run(action: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await action();
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : failure);
    } finally {
      isBusy = false;
    }
  }

  async function save() {
    if (!draft || !serverId) return;
    saveError = "";
    if (target.kind === "new") {
      const input = createInputFromDraft(draft);
      if (!input.ok) {
        saveError = input.error;
        return;
      }
      const hostId = serverId;
      await run(async () => {
        const created = await webhooksStore.create(hostId, input.value);
        toasts.success("Webhook saved. Copy its URL and give it to the sender.");
        onOpen({ kind: "webhook", serverId: hostId, webhookId: created.id });
      }, "Could not save the webhook.");
      return;
    }
    if (!webhook) return;
    const patch = updateInputFromDraft(draft, webhook.verification.scheme);
    if (!patch.ok) {
      saveError = patch.error;
      return;
    }
    const { webhookId } = target;
    const hostId = target.serverId;
    await run(async () => {
      await webhooksStore.update(hostId, webhookId, patch.value);
      if (draft) draft.verification.secret = "";
      toasts.success("Webhook saved.");
    }, "Could not save the webhook.");
  }

  function setEnabled(enabled: boolean) {
    if (target.kind !== "webhook") return;
    const { serverId: hostId, webhookId } = target;
    void run(() => webhooksStore.update(hostId, webhookId, { enabled }), enabled ? "Could not resume the webhook." : "Could not pause the webhook.");
  }

  function copyUrl() {
    if (target.kind !== "webhook") return;
    const { serverId: hostId, webhookId } = target;
    void run(async () => {
      await webhooksStore.copyUrl(hostId, webhookId);
      toasts.success("Copied the URL.");
    }, "Could not copy the URL.");
  }

  function rotate() {
    if (target.kind !== "webhook") return;
    if (!confirm("Rotate the URL? The old URL stops working at once. Give the new URL to the sender.")) return;
    const { serverId: hostId, webhookId } = target;
    void run(() => webhooksStore.rotate(hostId, webhookId), "Could not rotate the URL.");
  }

  function remove() {
    if (target.kind !== "webhook" || !webhook) return;
    if (!confirm(`Delete the webhook "${webhook.name}"? Its URL stops working, and its deliveries are deleted.`)) return;
    const { serverId: hostId, webhookId } = target;
    void run(async () => {
      await webhooksStore.remove(hostId, webhookId);
      onClose();
    }, "Could not delete the webhook.");
  }
</script>

<div class="flex flex-col gap-8">
  <div class="flex flex-wrap items-center gap-3">
    <Button size="sm" variant="ghost" onclick={onClose}><ArrowLeftIcon size={14} /> Webhooks</Button>
    <h2 class="text-lg font-medium">{target.kind === "new" ? "New webhook" : (webhook?.name ?? "Webhook")}</h2>
    {#if status}<span class="text-sm text-muted-foreground">{webhookStateLabel(status)}</span>{/if}
    {#if serverId}<span class="text-sm text-muted-foreground">on {hostLabelFor(serverId)}</span>{/if}
  </div>

  {#if target.kind === "webhook" && !webhook}
    <p class="text-sm text-muted-foreground">
      {readState === "reading" ? "Loading the webhook…" : readState === "missing" ? "This webhook does not exist." : `${hostLabelFor(target.serverId)} is not connected. The webhook is not shown.`}
    </p>
  {:else}
    {#if webhook?.verification.scheme === "none"}
      <p class="flex items-start gap-1.5 rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
        <ShieldAlertIcon size={14} class="mt-0.5 shrink-0" />
        <span>{UNVERIFIED_WARNING} Reason: {webhook.verification.reason}</span>
      </p>
    {/if}

    {#if webhook && target.kind === "webhook"}
      <section class="flex flex-col gap-3 rounded-xl border border-border/50 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-base font-medium">URL</h3>
          <span class="text-sm text-muted-foreground">{urlModeLabel(webhook.urlMode)}</span>
          {#if webhook.urlChanged}
            <span class="rounded-full border border-(--warning) px-2 text-xs text-(--warning)">URL changed since you copied it</span>
          {/if}
        </div>
        {#if url}
          <code class="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs break-all">{url.url ?? url.path}</code>
        {:else if !isOwner}
          <p class="text-sm text-muted-foreground">Only the owner sees the URL.</p>
        {/if}
        {#if reachability}<p class="text-sm text-muted-foreground">{reachability}</p>{/if}
        {#if isOwner}
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={isBusy || !url?.url} onclick={copyUrl}><CopyIcon size={14} /> Copy</Button>
            <Button size="sm" variant="outline" disabled={isBusy} onclick={rotate}><RotateIcon size={14} /> Rotate</Button>
          </div>
          {#if url && !url.url}<p class="text-xs text-muted-foreground">{REACHABILITY_TEXT.noUrl}</p>{/if}
        {/if}
      </section>

      <section class="flex flex-wrap items-center gap-2">
        {#if webhook.pausedByAdmin}
          <p class="text-sm text-muted-foreground">Paused by organization admin. Only an admin can resume it.</p>
        {:else if isOwner}
          <Button size="sm" variant="outline" disabled={isBusy} onclick={() => setEnabled(!webhook.enabled)}>
            {webhook.enabled ? "Pause" : "Resume"}
          </Button>
        {/if}
        {#if isOwner}
          <Button size="sm" variant="destructive" disabled={isBusy} onclick={remove}>Delete</Button>
        {/if}
      </section>
    {/if}

    {#if target.kind === "new"}
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Host</span>
        {#if connectedHosts.length > 0 && serverId}
          <SettingsSelect
            compact
            ariaLabel="Host"
            options={connectedHosts.map((host) => ({ value: host.serverId, label: host.label }))}
            value={serverId}
            onSelect={(next) => (chosenServerId = next)}
          />
        {:else}
          <p class="text-sm text-muted-foreground">No host is connected.</p>
        {/if}
      </div>
    {/if}

    {#if draft && serverId}
      <section class="flex flex-col gap-3">
        <h3 class="text-base font-medium">Settings</h3>
        {#if !isOwner}<p class="text-sm text-muted-foreground">Only the owner can change this webhook.</p>{/if}
        <WebhookEditor
          bind:draft
          {serverId}
          storedScheme={webhook?.verification.scheme ?? null}
          isNew={target.kind === "new"}
          disabled={!isOwner || isBusy}
        />
        {#if saveError}<p class="text-sm text-destructive">{saveError}</p>{/if}
        {#if isOwner}
          <Button size="sm" class="self-start" disabled={isBusy} onclick={() => void save()}>
            {target.kind === "new" ? "Create webhook" : "Save"}
          </Button>
        {/if}
      </section>

      {#if webhook && target.kind === "webhook"}
        <WebhookDeliveries serverId={target.serverId} {webhook} canReplay={isOwner && !webhook.pausedByAdmin && webhook.enabled} />
      {/if}
      {#if isOwner}
        <WebhookDryRun {serverId} webhookId={webhook?.id ?? null} actions={draft.actions} />
      {/if}
    {/if}
  {/if}
</div>
