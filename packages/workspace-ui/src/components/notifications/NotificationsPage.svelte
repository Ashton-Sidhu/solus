<script lang="ts">
  import type { NotificationView } from "@solus/contracts/notification-hub";
  import type { HubRow } from "@solus/client-core/notifications/merge";
  import { hubRowKey } from "@solus/client-core/notifications/merge";
  import { getClientShellContext, getWorkspaceContext, notificationHubStore as store } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import { ListEmpty, ListFilterBar, ListFilterGroup, ListPage, ListSkeleton } from "../ui/list-page";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";
  import NotificationRow from "./NotificationRow.svelte";
  import { notificationDestination } from "./lib/notification-actions";
  import {
    kindsForGroups,
    matchesNotificationQuery,
    NOTIFICATION_KIND_GROUPS,
    sourceStatusNote,
    type NotificationKindGroup,
  } from "@solus/client-core/notifications/presentation";

  let { paneId }: InlinePageProps = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);
  const shell = getClientShellContext();
  const open = $derived(session.router.at("notifications"));

  let query = $state("");
  let searchEl = $state<HTMLInputElement | null>(null);
  let kindGroups = $state<NotificationKindGroup[]>([]);

  const VIEW_OPTIONS: { value: NotificationView; label: string }[] = [
    { value: "all", label: "Inbox" },
    { value: "unread", label: "Unread" },
    { value: "archived", label: "Archived" },
  ];
  const sourceStates = $derived([...store.sources.values()]);
  const sourceOptions = $derived(sourceStates.map((state) => ({ value: state.source.sourceId, label: state.source.label })));
  const rows = $derived(store.entries.filter((row) => matchesNotificationQuery(row.notification, query)));
  // Ages are read when the rows change; no clock repaints the page.
  const now = $derived.by(() => {
    void rows;
    return Date.now();
  });
  const troubled = $derived(sourceStates.filter((state) => sourceStatusNote(state) && state.status !== "loading"));

  function serverIdOf(row: HubRow): string {
    return store.sources.get(row.sourceId)?.source.serverId ?? "";
  }

  function disabledReason(row: HubRow): string {
    const state = store.sources.get(row.sourceId);
    return state?.status === "ready" ? "Waiting for the answer…" : `${state?.source.label ?? "This source"} is unreachable`;
  }

  /** Open the row's resource on its own source; opening an unread row marks it read. */
  function openRow(row: HubRow): void {
    const key = hubRowKey(row.sourceId, row.notification.id);
    const destination = notificationDestination(row.notification, serverIdOf(row));
    if (!shell.canOpenResource(destination.route.kind)) {
      toasts.error("This window cannot open that item.");
      return;
    }
    shell.openResource(destination.route);
    if (row.notification.readAt === null && store.canChange(key)) void store.setRead(key, true);
  }

  async function choose(row: HubRow, change: (key: string) => Promise<boolean>): Promise<void> {
    const key = hubRowKey(row.sourceId, row.notification.id);
    if (await change(key)) return;
    // The source did not confirm the choice; the row shows what it holds after a fresh read.
    toasts.error(`${store.sources.get(row.sourceId)?.source.label ?? "The source"} did not confirm the change. Showing its current state.`);
  }

  function setKindGroups(next: NotificationKindGroup[]): void {
    kindGroups = next;
    store.setKinds(kindsForGroups(next));
  }

  function clearFilters(): void {
    query = "";
    store.sourceIds = [];
    setKindGroups([]);
  }
</script>

{#snippet filterBar()}
  <ListFilterBar
    bind:query
    bind:searchEl
    compactText
    placeholder="Search loaded notifications…"
    activeCount={kindGroups.length + store.sourceIds.length}
    onClearFilters={clearFilters}
  >
    {#snippet filterContent()}
      <ListFilterGroup label="Show" options={VIEW_OPTIONS} selected={[store.view]} onChange={(next) => store.setView(next[0] ?? "all")} />
      <ListFilterGroup label="Kind" options={NOTIFICATION_KIND_GROUPS.map(({ value, label }) => ({ value, label }))} selected={kindGroups} onChange={setKindGroups} multiple emptyLabel="All kinds" />
      {#if sourceOptions.length > 1}
        <ListFilterGroup label="Source" options={sourceOptions} selected={store.sourceIds} onChange={(next) => (store.sourceIds = next)} multiple emptyLabel="All sources" />
      {/if}
    {/snippet}
  </ListFilterBar>
{/snippet}

{#if open}
  <div class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-chrome-dense" aria-label="Notifications">
    <ListPage
      page="notifications"
      onRefresh={() => void store.refresh()}
      refreshing={store.isLoading}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={() => session.router.close("notifications")}
      toolbarFilters
      filters={filterBar}
    >
      {#if troubled.length > 0 || store.conflicts.length > 0}
        <ul class="mb-2 flex flex-col gap-1 px-2.5" aria-label="Source status" data-testid="notification-source-status">
          {#each troubled as state (state.source.sourceId)}
            <li class="text-chrome-dense text-muted-foreground"><span class="text-foreground">{state.source.label}</span> — {sourceStatusNote(state)}</li>
          {/each}
          {#each store.conflicts as organizationId (organizationId)}
            <li class="text-chrome-dense text-muted-foreground">Organization {organizationId} is listed by two accounts; its notifications are not shown until only one lists it.</li>
          {/each}
        </ul>
      {/if}

      {#if store.isLoading && rows.length === 0}
        <ListSkeleton plan={[[60, 40, 52, 34]]} identWidth={120} />
      {:else if rows.length === 0}
        <ListEmpty title={query || kindGroups.length || store.sourceIds.length ? "No notifications match." : store.view === "archived" ? "Nothing archived." : store.view === "unread" ? "You are caught up." : "No notifications yet."}>
          {#if query || kindGroups.length || store.sourceIds.length}
            Try a different search or filter.
          {:else}
            Review requests, assignments, and finished runs addressed to you appear here.
          {/if}
          {#snippet actions()}
            {#if query || kindGroups.length || store.sourceIds.length}
              <button type="button" class={PAGE_SECONDARY_BTN} onclick={clearFilters}>Clear filters</button>
            {/if}
          {/snippet}
        </ListEmpty>
      {:else}
        <ul class="flex flex-col" role="list" aria-label="Notifications">
          {#each rows as row (hubRowKey(row.sourceId, row.notification.id))}
            {@const key = hubRowKey(row.sourceId, row.notification.id)}
            <li>
              <NotificationRow
                notification={row.notification}
                sourceLabel={store.sources.get(row.sourceId)?.source.label ?? ""}
                openLabel={notificationDestination(row.notification, serverIdOf(row)).label}
                canChange={store.canChange(key)}
                disabledReason={disabledReason(row)}
                {now}
                onOpen={() => openRow(row)}
                onSetRead={(read) => void choose(row, (rowKey) => store.setRead(rowKey, read))}
                onSetArchived={(archived) => void choose(row, (rowKey) => store.setArchived(rowKey, archived))}
              />
            </li>
          {/each}
        </ul>
        {#if store.hasMore}
          <div class="flex justify-center py-3">
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => void store.loadMore()}>Load more</button>
          </div>
        {/if}
      {/if}
    </ListPage>
  </div>
{/if}
