<script lang="ts">
  /** The Organization view of Settings → Webhooks (docs/plans/webhooks.md §2.7, §4):
   *  the organization webhooks of all members, from the organization's Solus API.
   *  An admin pauses or resumes a webhook; nothing else. */
  import { untrack } from "svelte";
  import { webhookAdminStore as store } from "../../contexts/webhooks/webhook-admin.store.svelte";
  import { Button } from "../ui/button";
  import { ListEmpty } from "../ui/list-page";
  import { RowCard } from "../ui/row-card";
  import WebhookListRow from "./WebhookListRow.svelte";
  import {
    WEBHOOK_ADMIN_EMPTY_TEXT,
    WEBHOOK_ADMIN_FAILED_TEXT,
    WEBHOOK_ADMIN_LOADING_TEXT,
    webhookAdminRefusalText,
    webhookAdminRows,
  } from "./lib/webhook-admin-view";

  let { organizationId }: { organizationId: string } = $props();

  $effect(() => {
    const id = organizationId;
    untrack(() => void store.load(id));
  });

  const view = $derived(store.viewFor(organizationId));
  const rows = $derived(view?.kind === "loaded" ? webhookAdminRows(organizationId, view.webhooks) : []);
</script>

{#if view?.kind === "refused"}
  <p class="text-workspace-chrome text-muted-foreground" role="status">{webhookAdminRefusalText(view.error)}</p>
{:else if view?.kind === "failed"}
  <div class="flex flex-wrap items-center gap-2" role="alert">
    <p class="text-workspace-chrome text-destructive">{WEBHOOK_ADMIN_FAILED_TEXT}</p>
    <Button size="sm" variant="outline" onclick={() => void store.load(organizationId)}>Retry</Button>
  </div>
{:else if rows.length > 0}
  <RowCard>
    {#each rows as row (row.key)}
      {@const action = store.actionFor(row.ref)}
      <WebhookListRow
        name={row.name}
        state={row.state}
        stateLabel={row.stateLabel}
        details={[row.project, row.hostLabel, row.urlMode, row.actionTypes, row.owner]}
        warning={action?.kind === "refused" ? webhookAdminRefusalText(action.error) : action?.kind === "failed" ? WEBHOOK_ADMIN_FAILED_TEXT : null}
        lastDelivery={row.lastDelivery ? { label: row.lastDelivery.outcome, isFailing: row.lastDelivery.isFailing, at: row.lastDelivery.at } : null}
        deliveries24h={row.deliveries24h}
      >
        {#snippet trailing()}
          <Button
            size="xs"
            variant="outline"
            disabled={action?.kind === "busy"}
            onclick={() => void store.setPaused(row.ref, row.action === "pause")}
          >
            {row.action === "pause" ? "Pause" : "Resume"}
          </Button>
        {/snippet}
      </WebhookListRow>
    {/each}
  </RowCard>
{:else if view?.kind === "loaded"}
  <ListEmpty title={WEBHOOK_ADMIN_EMPTY_TEXT} />
{:else}
  <p class="py-6 text-center text-workspace-chrome text-muted-foreground" role="status">{WEBHOOK_ADMIN_LOADING_TEXT}</p>
{/if}
