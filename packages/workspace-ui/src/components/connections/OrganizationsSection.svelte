<script lang="ts">
  /** This machine's organizations (docs/plans/organization-scope.md §3.1, §6.1):
   *  each one the host may deliver records to, whether the machine is shared with
   *  it, and its Insights policy. When the policy syncs every session there is
   *  nothing to choose; when it is off, the person at this host may opt its work
   *  in for that organization. Read from the machine, never from the workspace
   *  service, and shown on desktop, web, and mobile alike. */
  import { onMount } from "svelte";
  import { RefreshCw as RefreshIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { organizationsStore } from "./organizations.store.svelte";
  import { attachmentSummary, deliverySummary, hostCategoryLabel, insightsDetail, organizationDetail, organizationRows } from "@solus/client-core/organization-rows";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  // The parent keys this section on `serverId`, so one read on mount is enough.
  onMount(() => {
    const stop = organizationsStore.listen();
    void organizationsStore.refresh(serverId);
    return stop;
  });

  const status = $derived(organizationsStore.statusFor(serverId));
  const error = $derived(organizationsStore.errorByServer.get(serverId) ?? null);
  const loading = $derived(organizationsStore.isLoading(serverId));
  const rows = $derived(status ? organizationRows(status) : []);
  const attachment = $derived(status ? attachmentSummary(status) : null);
  const delivery = $derived(status ? deliverySummary(status) : null);
  const description = $derived(
    status
      ? status.linked
        ? `${hostCategoryLabel(status.category)}${status.owner ? ` · linked by ${status.owner.name ?? status.owner.email ?? "its owner"}` : ""}`
        : `${hostCategoryLabel(status.category)} · not linked to Solus Cloud, so it stands in no organization.`
      : error
        ? "This host cannot say which organizations it stands in."
        : "Reading this host's organizations…",
  );
</script>

<SettingsSection label="Organizations" {description}>
  {#snippet action()}
    <Button
      variant="ghost"
      size="icon-sm"
      class="text-(--solus-text-tertiary)"
      aria-label="Refresh organizations"
      disabled={loading}
      onclick={() => void organizationsStore.refresh(serverId)}
    >
      <RefreshIcon size={13} class={loading ? "animate-spin" : undefined} />
    </Button>
  {/snippet}
  {#if attachment}
    <SettingsRow label={attachment.label} description={attachment.description} testId="organization-attachment" />
  {/if}
  {#if delivery}
    <SettingsRow label="Delivery" description={delivery} testId="organization-delivery" />
  {/if}
  {#if error && !status}
    <SettingsRow label="Unavailable" description={error} />
  {:else if status && rows.length === 0}
    <SettingsRow
      label="No organizations"
      description={status.linked
        ? "This host delivers to no organization yet. Join one on the Solus Cloud website, or share this host with one."
        : "Link this host to Solus Cloud to see its organizations."}
    />
  {:else}
    {#each rows as row (row.organizationId)}
      <SettingsRow label={row.name} description={organizationDetail(row)} testId="organization-row">
        {#snippet body()}
          <div class="flex flex-col gap-3 @min-[30rem]/pane:grid @min-[30rem]/pane:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[30rem]/pane:items-center @min-[30rem]/pane:gap-8">
            <p class="text-pretty text-[13px] leading-[1.45] text-muted-foreground/80" data-testid="organization-insights">
              {insightsDetail(row)}
            </p>
            {#if !row.insightsManaged}
              <label class="flex items-center gap-2 text-[13px] text-foreground @min-[30rem]/pane:justify-end">
                <span>Send this computer's Insights for this organization</span>
                <Switch
                  checked={row.insightsOptedIn}
                  disabled={organizationsStore.isBusy(serverId, row.organizationId)}
                  onclick={() => void organizationsStore.setInsightsOptIn(serverId, row.organizationId, !row.insightsOptedIn)}
                  size="default"
                  aria-label={`Send this computer's Insights for ${row.name}`}
                />
              </label>
            {/if}
          </div>
        {/snippet}
      </SettingsRow>
    {/each}
  {/if}
</SettingsSection>
