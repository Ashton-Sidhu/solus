<script lang="ts">
  /** The Organization view of Settings → Webhooks (docs/plans/webhooks.md §2.7, §4):
   *  the organization webhooks of all members, from the organization's Solus API.
   *  An admin pauses or resumes a webhook; nothing else. */
  import { untrack } from "svelte";
  import { webhookAdminStore as store } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import * as Table from "../ui/table";
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
{:else}
  <Table.Root>
    <Table.Header>
      <Table.Row>
        <Table.Head>Name</Table.Head>
        <Table.Head>Host</Table.Head>
        <Table.Head>Owner</Table.Head>
        <Table.Head>Project</Table.Head>
        <Table.Head>URL</Table.Head>
        <Table.Head>State</Table.Head>
        <Table.Head>Actions</Table.Head>
        <Table.Head>Last delivery</Table.Head>
        <Table.Head class="text-right">24 hours</Table.Head>
        <Table.Head><span class="sr-only">Pause or resume</span></Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {#each rows as row (row.key)}
        {@const action = store.actionFor(row.ref)}
        <Table.Row>
          <Table.Cell class="max-w-56 font-medium whitespace-normal text-foreground">{row.name}</Table.Cell>
          <Table.Cell>{row.hostLabel}</Table.Cell>
          <Table.Cell>{row.owner}</Table.Cell>
          <Table.Cell>{row.project}</Table.Cell>
          <Table.Cell>{row.urlMode}</Table.Cell>
          <Table.Cell class={row.state === "active" ? "" : "text-muted-foreground"}>{row.stateLabel}</Table.Cell>
          <Table.Cell class="max-w-48 whitespace-normal">{row.actionTypes}</Table.Cell>
          <Table.Cell>
            {#if row.lastDelivery}
              <span class={row.lastDelivery.isFailing ? "text-destructive" : ""}>{row.lastDelivery.outcome}</span>
              <span class="text-muted-foreground">· {relativeTime(row.lastDelivery.at)}</span>
            {:else}
              <span class="text-muted-foreground">None</span>
            {/if}
          </Table.Cell>
          <Table.Cell class="text-right tabular-nums">{row.deliveries24h}</Table.Cell>
          <Table.Cell class="max-w-56 whitespace-normal">
            <Button
              size="xs"
              variant="outline"
              disabled={action?.kind === "busy"}
              onclick={() => void store.setPaused(row.ref, row.action === "pause")}
            >
              {row.action === "pause" ? "Pause" : "Resume"}
            </Button>
            {#if action?.kind === "refused"}
              <p class="mt-1 text-xs text-destructive" role="alert">{webhookAdminRefusalText(action.error)}</p>
            {:else if action?.kind === "failed"}
              <p class="mt-1 text-xs text-destructive" role="alert">{WEBHOOK_ADMIN_FAILED_TEXT}</p>
            {/if}
          </Table.Cell>
        </Table.Row>
      {:else}
        <Table.Row>
          <Table.Cell colspan={10} class="text-muted-foreground">
            {view?.kind === "loaded" ? WEBHOOK_ADMIN_EMPTY_TEXT : WEBHOOK_ADMIN_LOADING_TEXT}
          </Table.Cell>
        </Table.Row>
      {/each}
    </Table.Body>
  </Table.Root>
{/if}
