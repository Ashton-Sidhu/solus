<script lang="ts">
  /** Settings → Webhooks (docs/plans/webhooks.md §4): one table for the webhooks
   *  of every connected host. A member of an organization also gets the
   *  Organization view (§2.7). The view, the filters, and the open webhook are
   *  the page URL. */
  import { untrack } from "svelte";
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { webhooksStore } from "../../contexts/webhooks/webhooks.store.svelte";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import { ListEmpty, ListFilterBar, ListFilterGroup } from "../ui/list-page";
  import { RowCard } from "../ui/row-card";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import WebhookDetail from "./WebhookDetail.svelte";
  import WebhookAdminTable from "./WebhookAdminTable.svelte";
  import WebhookListRow from "./WebhookListRow.svelte";
  import { chosenAdminOrganization } from "./lib/webhook-admin-view";
  import { hostLabelFor, organizationLabel, rowReachabilityText } from "./lib/webhook-host";
  import { urlModeLabel } from "./lib/webhook-reachability";
  import { UNVERIFIED_WARNING } from "./lib/webhook-draft";
  import {
    actionsSummary,
    distinctChoices,
    EMPTY_WEBHOOKS_VIEW,
    filterWebhookRows,
    isFailingOutcome,
    OUTCOME_FILTERS,
    outcomeLabel,
    parseWebhooksView,
    projectLabel,
    serializeWebhooksView,
    webhookOwnerLabel,
    webhookState,
    webhookStateLabel,
    type WebhookOpenTarget,
    type WebhookOutcomeFilter,
    type WebhooksView,
    type WebhookState,
    type WebhooksScope,
  } from "./lib/webhooks-view";
  import type { WebhookUrlMode } from "@solus/contracts/webhooks";

  const session = getWorkspaceContext();
  const view = $derived(parseWebhooksView(session.settingsWebhooksView));

  $effect(() => untrack(() => webhooksStore.watch()));
  // A row names the app a `call_app` action calls.
  $effect(() => untrack(() => appsStore.watch()));

  function setView(patch: Partial<WebhooksView>) {
    session.setSettingsWebhooksView(serializeWebhooksView({ ...view, ...patch }));
  }

  function open(target: WebhookOpenTarget | null) {
    setView({ open: target });
  }

  const SCOPE_CHOICES: { value: WebhooksScope; label: string }[] = [
    { value: "hosts", label: "Hosts" },
    { value: "organization", label: "Organization" },
  ];

  const organizations = $derived(serversStore.organizations);
  const scope = $derived<WebhooksScope>(organizations.length > 0 ? view.scope : "hosts");
  const adminOrganizationId = $derived(
    chosenAdminOrganization(
      organizations.map((organization) => organization.organizationId),
      view.adminOrganization,
      serversStore.activeOrganizationId,
    ),
  );
  const organizationChoicesForAdmin = $derived(
    organizations.map((organization) => ({ value: organization.organizationId, label: organization.name })),
  );

  const allRows = $derived(webhooksStore.rows);
  const rows = $derived(filterWebhookRows(allRows, view));
  // A host that is not ready, or that did not answer, gets one row that says so.
  const missingHosts = $derived(webhooksStore.hosts.filter((host) => !host.connected || host.status === "unavailable"));
  // Each one shows once while the page is open, as a toast rather than a part of the list.
  const toastedHosts = new Set<string>();
  $effect(() => {
    for (const host of missingHosts) {
      const key = `${host.serverId}\n${host.connected}`;
      if (toastedHosts.has(key)) continue;
      toastedHosts.add(key);
      untrack(() =>
        toasts.info(
          host.connected ? `${host.label} did not give its webhooks` : `${host.label} is not connected`,
          {
            id: `webhooks-host-${host.serverId}`,
            description: host.connected ? "It can be an older version of Solus." : "Its webhooks are not shown.",
          },
        ),
      );
    }
  });
  const isLoading = $derived(webhooksStore.hosts.some((host) => host.connected && host.status === "loading"));

  const ALL = { value: "", label: "All" };
  const hostChoices = $derived([ALL, ...webhooksStore.hosts.map((host) => ({ value: host.serverId, label: host.label }))]);
  const projectChoices = $derived([ALL, ...distinctChoices(allRows, ({ webhook }) => (webhook.project ? { value: webhook.project, label: projectLabel(webhook.project) } : null))]);
  const ownerChoices = $derived([ALL, ...distinctChoices(allRows, ({ webhook }) => ({ value: webhook.ownerKey, label: webhookOwnerLabel(webhook) }))]);
  const organizationChoices = $derived([
    ALL,
    ...distinctChoices(allRows, ({ webhook }) => ({
      value: webhook.organizationId,
      label: organizationLabel(webhook.organizationId),
    })),
  ]);
  const stateChoices: { value: "" | WebhookState; label: string }[] = [
    { value: "", label: "All" },
    ...(["active", "paused", "admin-paused"] as const).map((state) => ({ value: state, label: webhookStateLabel(state) })),
  ];
  const outcomeChoices: { value: "" | WebhookOutcomeFilter; label: string }[] = [
    { value: "", label: "All" },
    ...OUTCOME_FILTERS.map((outcome) => ({ value: outcome, label: outcomeLabel(outcome) })),
  ];
  const modeChoices: { value: "" | WebhookUrlMode; label: string }[] = [
    { value: "", label: "All" },
    ...(["cloud", "direct", "none"] as const).map((mode) => ({ value: mode, label: urlModeLabel(mode) })),
  ];

  const activeFilterCount = $derived(
    [view.host, view.project, view.state, view.outcome, view.urlMode, view.owner, view.organization].filter(Boolean).length,
  );
  const hasFilters = $derived(!!view.query || activeFilterCount > 0);

  function clearFilters() {
    setView({ ...EMPTY_WEBHOOKS_VIEW, scope: view.scope, adminOrganization: view.adminOrganization });
  }
</script>

{#if view.open}
  {#key view.open.kind === "webhook" ? `${view.open.serverId}\n${view.open.webhookId}` : "new"}
    <WebhookDetail
      target={view.open}
      defaultServerId={view.host}
      onClose={() => open(null)}
      onOpen={(target) => open(target)}
    />
  {/key}
{:else}
  <section class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2">
      {#if organizations.length > 0}
        <!-- The chips match the settings page's own chips (the MCP page's views). -->
        <div class="flex shrink-0 items-center gap-1" role="tablist" aria-label="Webhooks view">
          {#each SCOPE_CHOICES as choice (choice.value)}
            {@const isCurrent = scope === choice.value}
            <button
              type="button"
              role="tab"
              aria-selected={isCurrent}
              class="flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-workspace-chrome outline-none transition-colors [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-8 {isCurrent
                ? 'bg-background font-medium text-foreground shadow-[0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_5%,transparent),0_1px_6px_color-mix(in_oklch,var(--foreground)_6%,transparent)]'
                : 'bg-transparent text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground'}"
              onclick={() => setView({ scope: choice.value })}
            >
              {choice.label}
            </button>
          {/each}
        </div>
      {/if}
      {#if scope === "hosts"}
        <ListFilterBar
          bind:query={() => view.query, (query) => setView({ query })}
          compactText
          placeholder="Search names and projects"
          activeCount={activeFilterCount}
          onClearFilters={clearFilters}
        >
          {#snippet filterContent()}
            <ListFilterGroup label="Host" options={hostChoices} selected={[view.host ?? ""]} onChange={([host]) => setView({ host: host || null })} />
            <ListFilterGroup label="Project" options={projectChoices} selected={[view.project ?? ""]} onChange={([project]) => setView({ project: project || null })} />
            <ListFilterGroup label="State" options={stateChoices} selected={[view.state ?? ""]} onChange={([state]) => setView({ state: state || null })} />
            <ListFilterGroup label="Last outcome" options={outcomeChoices} selected={[view.outcome ?? ""]} onChange={([outcome]) => setView({ outcome: outcome || null })} />
            <ListFilterGroup label="URL" options={modeChoices} selected={[view.urlMode ?? ""]} onChange={([urlMode]) => setView({ urlMode: urlMode || null })} />
            <ListFilterGroup label="Owner" options={ownerChoices} selected={[view.owner ?? ""]} onChange={([owner]) => setView({ owner: owner || null })} />
            <ListFilterGroup label="Organization" options={organizationChoices} selected={[view.organization ?? ""]} onChange={([organization]) => setView({ organization: organization || null })} />
          {/snippet}
        </ListFilterBar>
        <Button size="sm" variant="outline" class="shrink-0" onclick={() => open({ kind: "new", serverId: view.host })}>
          <PlusIcon size={14} /> New webhook
        </Button>
      {/if}
    </div>

    {#if scope === "organization" && adminOrganizationId}
      <div class="flex flex-wrap items-center gap-1.5 text-workspace-chrome text-muted-foreground">
        <span>Organization</span>
        {#if organizationChoicesForAdmin.length > 1}
          <SettingsSelect
            compact
            ariaLabel="Organization"
            options={organizationChoicesForAdmin}
            value={adminOrganizationId}
            onSelect={(adminOrganization) => setView({ adminOrganization })}
          />
        {:else}
          <span class="text-foreground">{organizationChoicesForAdmin[0]?.label}</span>
        {/if}
      </div>
      <p class="text-workspace-chrome text-muted-foreground">
        The organization webhooks of all members. An admin can pause or resume them, but cannot change them.
      </p>
      <WebhookAdminTable organizationId={adminOrganizationId} />
    {:else}
      {#if rows.length > 0}
        <RowCard>
          {#each rows as row (`${row.serverId}\n${row.webhook.id}`)}
            {@const webhook = row.webhook}
            {@const state = webhookState(webhook)}
            <WebhookListRow
              name={webhook.name}
              {state}
              stateLabel={webhookStateLabel(state)}
              details={[projectLabel(webhook.project), hostLabelFor(row.serverId), urlModeLabel(webhook.urlMode), actionsSummary(webhook, (appId) => appsStore.get(row.serverId, appId)?.app.name), webhookOwnerLabel(webhook)]}
              note={rowReachabilityText(row)}
              warning={webhook.verification.scheme === "none" ? `${UNVERIFIED_WARNING} Reason: ${webhook.verification.reason}` : null}
              lastDelivery={webhook.lastDelivery
                ? { label: outcomeLabel(webhook.lastDelivery.outcome), isFailing: isFailingOutcome(webhook.lastDelivery.outcome), at: webhook.lastDelivery.at }
                : null}
              deliveries24h={webhook.deliveries24h}
              onOpen={() => open({ kind: "webhook", serverId: row.serverId, webhookId: webhook.id })}
            />
          {/each}
        </RowCard>
      {:else if isLoading}
        <p class="py-6 text-center text-workspace-chrome text-muted-foreground" role="status">Loading webhooks…</p>
      {:else if hasFilters}
        <ListEmpty title="No webhooks match these filters.">
          Try a different search or filter.
          {#snippet actions()}
            <Button size="sm" variant="outline" onclick={clearFilters}>Clear filters</Button>
          {/snippet}
        </ListEmpty>
      {:else}
        <ListEmpty title="No webhooks yet.">
          Make one to let another service start agent work.
          {#snippet actions()}
            <Button size="sm" variant="outline" onclick={() => open({ kind: "new", serverId: view.host })}>
              <PlusIcon size={14} /> New webhook
            </Button>
          {/snippet}
        </ListEmpty>
      {/if}
    {/if}
  </section>
{/if}
