<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { getWorkspaceContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import { EMPTY_WEBHOOKS_VIEW, serializeWebhooksView } from "../../webhooks/lib/webhooks-view";
  import { REACHABILITY_TEXT, urlModeLabel } from "../../webhooks/lib/webhook-reachability";
  import AppSectionState from "./AppSectionState.svelte";
  import { webhookRunText } from "../lib/app-view";

  /**
   * The webhooks the active version declares (docs/plans/apps.md §8). The
   * person copies the URL and the signing secret into the other service. The
   * webhook owner runs each one, so its settings and deliveries open there.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  const session = getWorkspaceContext();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    untrack(() => void appsStore.webhooks.load(hostId, appId));
  });
  const webhooks = $derived(appsStore.webhooks.get(serverId, app.id));

  function openWebhook(webhookId: string) {
    const view = serializeWebhooksView({ ...EMPTY_WEBHOOKS_VIEW, open: { kind: "webhook", serverId, webhookId } });
    session.showSettings("webhooks", "click", view);
  }
</script>

<AppSectionState
  count={webhooks?.length}
  error={appsStore.webhooks.errorFor(serverId, app.id)}
  empty="This app declares no webhook."
  onRetry={() => void appsStore.webhooks.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-webhooks">
    {#each webhooks ?? [] as webhook (webhook.name)}
      <li class="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 px-3 py-2">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="min-w-0 truncate font-medium">{webhook.name}</span>
          <span class="min-w-0 truncate text-xs text-muted-foreground">{webhookRunText(webhook)}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{urlModeLabel(webhook.urlMode)}{webhook.enabled ? "" : " · Paused"}</span>
        </div>
        {#if webhook.problem}
          <p class="m-0 text-xs text-destructive text-pretty" role="alert">{webhook.problem}</p>
        {/if}
        {#if webhook.url}
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="w-12 shrink-0 text-xs text-muted-foreground">URL</span>
            <code class="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted/50 px-1.5 py-1 font-mono text-xs whitespace-nowrap">{webhook.url}</code>
            <CopyButton text={webhook.url} title="Copy the URL" />
          </div>
        {:else if webhook.webhookId}
          <p class="m-0 text-xs text-muted-foreground">{REACHABILITY_TEXT.noUrl}</p>
        {/if}
        {#if webhook.secret !== null}
          <!-- A credential: the value goes to the clipboard and is not drawn. -->
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="w-12 shrink-0 text-xs text-muted-foreground">Secret</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">The signing secret the host made. Give it to the sender.</span>
            <CopyButton text={webhook.secret} title="Copy the signing secret" />
          </div>
        {/if}
        {#if webhook.webhookId}
          {@const webhookId = webhook.webhookId}
          <Button size="xs" variant="link" class="self-start px-0" onclick={() => openWebhook(webhookId)}>Open in Webhooks</Button>
        {/if}
      </li>
    {/each}
  </ul>
</AppSectionState>
