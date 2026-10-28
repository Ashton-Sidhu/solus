<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["webhook", "hook", "github", "sender", "delivery", "deliveries", "url", "trigger", "event", "organization", "admin"];
</script>

<script lang="ts">
  /** Settings → Webhooks (docs/plans/webhooks.md §4): one table for the webhooks
   *  of every connected host. A member of an organization also gets the
   *  Organization view (§2.7). The view, the filters, and the open webhook are
   *  the page URL. */
  import { untrack } from "svelte";
  import { Plus as PlusIcon, ShieldAlert as ShieldAlertIcon } from "@lucide/svelte";
  import { getWorkspaceContext, serversStore, webhooksStore } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import { Button } from "../ui/button";
  import { SearchField } from "../ui/search-field";
  import * as Table from "../ui/table";
  import * as Tabs from "../ui/tabs";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import WebhookDetail from "./WebhookDetail.svelte";
  import WebhookAdminTable from "./WebhookAdminTable.svelte";
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

  function setView(patch: Partial<WebhooksView>) {
    session.setSettingsWebhooksView(serializeWebhooksView({ ...view, ...patch }));
  }

  function open(target: WebhookOpenTarget | null) {
    setView({ open: target });
  }

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

  const hasFilters = $derived(
    !!(view.query || view.host || view.project || view.state || view.outcome || view.urlMode || view.owner || view.organization),
  );
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
    {#if organizations.length > 0}
      <Tabs.Root value={scope} onValueChange={(next) => setView({ scope: next === "organization" ? "organization" : "hosts" })}>
        <Tabs.List aria-label="Webhooks view">
          <Tabs.Trigger value="hosts">Hosts</Tabs.Trigger>
          <Tabs.Trigger value="organization">Organization</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
    {/if}
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
      <div class="flex flex-wrap items-center gap-2">
        <SearchField
          bind:value={() => view.query, (query) => setView({ query })}
          placeholder="Search names and projects"
          class="basis-64"
        />
        <Button size="sm" variant="outline" onclick={() => open({ kind: "new", serverId: view.host })}>
          <PlusIcon size={14} /> New webhook
        </Button>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 text-workspace-chrome text-muted-foreground">
        <span>Host</span>
        <SettingsSelect compact ariaLabel="Host" options={hostChoices} value={view.host ?? ""} onSelect={(host) => setView({ host: host || null })} />
        <span class="ml-2">Project</span>
        <SettingsSelect compact ariaLabel="Project" options={projectChoices} value={view.project ?? ""} onSelect={(project) => setView({ project: project || null })} />
        <span class="ml-2">State</span>
        <SettingsSelect compact ariaLabel="State" options={stateChoices} value={view.state ?? ""} onSelect={(state) => setView({ state: state || null })} />
        <span class="ml-2">Last outcome</span>
        <SettingsSelect compact ariaLabel="Last outcome" options={outcomeChoices} value={view.outcome ?? ""} onSelect={(outcome) => setView({ outcome: outcome || null })} />
        <span class="ml-2">URL</span>
        <SettingsSelect compact ariaLabel="URL mode" options={modeChoices} value={view.urlMode ?? ""} onSelect={(urlMode) => setView({ urlMode: urlMode || null })} />
        <span class="ml-2">Owner</span>
        <SettingsSelect compact ariaLabel="Owner" options={ownerChoices} value={view.owner ?? ""} onSelect={(owner) => setView({ owner: owner || null })} />
        <span class="ml-2">Organization</span>
        <SettingsSelect compact ariaLabel="Organization" options={organizationChoices} value={view.organization ?? ""} onSelect={(organization) => setView({ organization: organization || null })} />
        {#if hasFilters}
          <Button size="xs" variant="ghost" onclick={() => setView({ ...EMPTY_WEBHOOKS_VIEW, scope: view.scope, adminOrganization: view.adminOrganization })}>Clear filters</Button>
        {/if}
      </div>

      <Table.Root>
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>Host</Table.Head>
            <Table.Head>Project</Table.Head>
            <Table.Head>URL</Table.Head>
            <Table.Head>State</Table.Head>
            <Table.Head>Actions</Table.Head>
            <Table.Head>Last delivery</Table.Head>
            <Table.Head class="text-right">24 hours</Table.Head>
            <Table.Head>Owner</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each missingHosts as host (host.serverId)}
            <Table.Row>
              <Table.Cell colspan={9} class="text-muted-foreground">
                {host.connected
                  ? `${host.label} did not give its webhooks. It can be an older version of Solus.`
                  : `${host.label} is not connected. Its webhooks are not shown.`}
              </Table.Cell>
            </Table.Row>
          {/each}
          {#each rows as row (`${row.serverId}\n${row.webhook.id}`)}
            {@const webhook = row.webhook}
            {@const state = webhookState(webhook)}
            {@const reachability = rowReachabilityText(row)}
            <Table.Row class="hover:bg-[var(--wash-1)]">
              <Table.Cell class="max-w-56 whitespace-normal">
                <button
                  type="button"
                  class="cursor-pointer text-left font-medium text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
                  onclick={() => open({ kind: "webhook", serverId: row.serverId, webhookId: webhook.id })}
                >
                  {webhook.name}
                </button>
                {#if webhook.verification.scheme === "none"}
                  <p class="mt-1 flex items-start gap-1 text-xs text-destructive">
                    <ShieldAlertIcon size={12} class="mt-0.5 shrink-0" />
                    <span>{UNVERIFIED_WARNING} Reason: {webhook.verification.reason}</span>
                  </p>
                {/if}
              </Table.Cell>
              <Table.Cell>{hostLabelFor(row.serverId)}</Table.Cell>
              <Table.Cell title={webhook.project ?? undefined}>{projectLabel(webhook.project)}</Table.Cell>
              <Table.Cell class="max-w-56 whitespace-normal">
                <span>{urlModeLabel(webhook.urlMode)}</span>
                {#if reachability}<p class="mt-0.5 text-xs text-muted-foreground">{reachability}</p>{/if}
              </Table.Cell>
              <Table.Cell class={state === "active" ? "" : "text-muted-foreground"}>{webhookStateLabel(state)}</Table.Cell>
              <Table.Cell class="max-w-48 whitespace-normal">{actionsSummary(webhook)}</Table.Cell>
              <Table.Cell>
                {#if webhook.lastDelivery}
                  <span class={isFailingOutcome(webhook.lastDelivery.outcome) ? "text-destructive" : ""}>{outcomeLabel(webhook.lastDelivery.outcome)}</span>
                  <span class="text-muted-foreground">· {relativeTime(webhook.lastDelivery.at)}</span>
                {:else}
                  <span class="text-muted-foreground">None</span>
                {/if}
              </Table.Cell>
              <Table.Cell class="text-right tabular-nums">{webhook.deliveries24h}</Table.Cell>
              <Table.Cell>{webhookOwnerLabel(webhook)}</Table.Cell>
            </Table.Row>
          {:else}
            {#if missingHosts.length === 0}
              <Table.Row>
                <Table.Cell colspan={9} class="text-muted-foreground">
                  {isLoading ? "Loading webhooks…" : hasFilters ? "No webhooks match these filters." : "No webhooks yet. Make one to let another service start agent work."}
                </Table.Cell>
              </Table.Row>
            {/if}
          {/each}
        </Table.Body>
      </Table.Root>
    {/if}
  </section>
{/if}
