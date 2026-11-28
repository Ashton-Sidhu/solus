<script lang="ts">
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { AgentId } from "@solus/contracts/types";
  import { isSolusApiId } from "@solus/contracts/uplink";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    buildUsageOverview,
    filterUsageOverview,
    formatCheckedAt,
    groupUsageWindowsByModelGroup,
    hasUsageSectionContent,
    unsupportedAccountOf,
    usageUnsupportedMessage,
    type HostUsageInput,
    type UsageDisplayMode,
    type UsageProviderGroup,
    type UsageStateFilter,
  } from "@solus/client-core/usage-limits";
  import {
    ChevronDown as ChevronDownIcon,
    ListFilter as ListFilterIcon,
    RefreshCw as RefreshCwIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext, hosts, serversStore } from "../../../contexts";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import { signInCommand } from "../../project-panel/lib/usage-meters";
  import { Button } from "../../ui/button";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import {
    USAGE_STATE_OPTIONS,
    harnessFilterSummary,
    hostFilterSummary,
    usageStateLabel,
  } from "./lib/usage-chart";
  import UsageAccountEmail from "./UsageAccountEmail.svelte";
  import UsageCallout from "./UsageCallout.svelte";
  import UsageModelGroupPanel from "./UsageModelGroupPanel.svelte";
  import UsageProviderIcon from "./UsageProviderIcon.svelte";
  import UsageResetTimer from "./UsageResetTimer.svelte";
  import UsageWindowCard from "./UsageWindowCard.svelte";

  const DISPLAY_MODE_STORAGE_KEY = "solus.usage.displayMode";

  function readStoredDisplayMode(): UsageDisplayMode {
    try {
      const value = localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
      if (value === "used" || value === "remaining") return value;
    } catch {
      // Ignore storage access failures in restricted browser contexts.
    }
    return "remaining";
  }

  const workspace = getWorkspaceContext();

  let now = $state(Date.now());
  let displayMode = $state<UsageDisplayMode>(readStoredDisplayMode());
  let refreshing = $state(false);
  /** Empty set means all connected hosts. */
  const selectedHostIds = new SvelteSet<string>();
  /** Empty set means all harnesses. */
  const selectedProviders = new SvelteSet<AgentId>();
  let stateFilter = $state<UsageStateFilter>("all");

  function setDisplayMode(mode: UsageDisplayMode) {
    displayMode = mode;
    try {
      localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors.
    }
  }

  const connectedHosts = $derived.by(() => {
    void serversStore.servers;
    return serverConnections
      .serverIds()
      .filter((serverId) => !isSolusApiId(serverId))
      .map((serverId) => {
        const host = hosts.get(serverId);
        const label =
          serversStore.hostFor(serverId)?.label ??
          serverConnections.connectionFor(serverId)?.target.label ??
          serverId;
        const connected = serversStore.readinessFor(serverId).readiness === "ready";
        const canReadUsage = host?.me.may("host.usage.read") ?? true;
        return { serverId, label, host, connected, canReadUsage };
      })
      .filter((entry) => entry.canReadUsage);
  });

  const watchedHostIds = $derived(connectedHosts.map((entry) => entry.serverId).join("\u0000"));

  // Watch usage on every connected host while Settings → Usage is open.
  $effect(() => {
    void watchedHostIds;
    const hostList = untrack(() => connectedHosts);
    const releases = hostList
      .map((entry) => entry.host?.watchUsage())
      .filter((fn): fn is () => void => !!fn);
    const stopClock = messageTimestampClock.subscribe((value) => {
      now = value;
    });
    return () => {
      stopClock();
      for (const release of releases) release();
    };
  });

  const activeHostEntries = $derived(
    selectedHostIds.size === 0
      ? connectedHosts
      : connectedHosts.filter((entry) => selectedHostIds.has(entry.serverId)),
  );

  const hostInputs = $derived<HostUsageInput[]>(
    activeHostEntries.map((entry) => {
      const fact = entry.host?.usage;
      const availableProviders = entry.host?.machineInfo?.agents
        .filter((agent) => agent.available !== false)
        .map((agent) => agent.id);
      if (!fact || fact.state === "loading") {
        return {
          serverId: entry.serverId,
          label: entry.label,
          connected: entry.connected,
          state: "loading",
          snapshots: [],
          availableProviders,
        };
      }
      if (fact.state === "error") {
        return {
          serverId: entry.serverId,
          label: entry.label,
          connected: entry.connected,
          state: "error",
          error: fact.message,
          snapshots: [],
          availableProviders,
        };
      }
      return {
        serverId: entry.serverId,
        label: entry.label,
        connected: entry.connected,
        state: "ready",
        snapshots: fact.value,
        availableProviders,
      };
    }),
  );

  const rawOverview = $derived(buildUsageOverview(hostInputs, now));
  const filteredOverview = $derived(
    filterUsageOverview(rawOverview, {
      providers: selectedProviders,
      state: stateFilter,
    }),
  );

  const showHostNames = $derived(activeHostEntries.length > 1);
  const hasActiveFilters = $derived(
    selectedHostIds.size > 0 || selectedProviders.size > 0 || stateFilter !== "all",
  );

  const staleOrFailedHostSet = $derived(
    new Set([
      ...rawOverview.failedHosts.map((item) => item.label),
      ...rawOverview.staleHosts,
    ]),
  );

  const sectionProviders = $derived(
    filteredOverview.providers.filter(hasUsageSectionContent),
  );

  const nonMeteredNotices = $derived(
    filteredOverview.providers.flatMap((group) =>
      group.nonMeteredAccounts
        .filter((account) => account.status !== "unsupported")
        .map((account) => ({
          groupLabel: group.label,
          account,
        })),
    ),
  );

  const latestCheckedLabel = $derived.by(() => {
    let newest = 0;
    for (const group of rawOverview.providers) {
      for (const account of group.accounts) {
        if (account.fetchedAt > newest) newest = account.fetchedAt;
      }
    }
    return newest > 0 ? formatCheckedAt(newest) : null;
  });

  function toggleHostFilter(serverId: string) {
    if (selectedHostIds.has(serverId)) {
      selectedHostIds.delete(serverId);
    } else {
      selectedHostIds.add(serverId);
    }
    if (selectedHostIds.size >= connectedHosts.length) {
      selectedHostIds.clear();
    }
  }

  function toggleProviderFilter(provider: AgentId) {
    if (selectedProviders.has(provider)) {
      selectedProviders.delete(provider);
    } else {
      selectedProviders.add(provider);
    }
    if (selectedProviders.size >= rawOverview.providers.length) {
      selectedProviders.clear();
    }
  }

  function clearAllFilters() {
    selectedHostIds.clear();
    selectedProviders.clear();
    stateFilter = "all";
  }

  async function refreshAll() {
    if (refreshing || activeHostEntries.length === 0) return;
    refreshing = true;
    try {
      await Promise.allSettled(
        activeHostEntries.map((entry) => entry.host?.refresh("usage", { force: true })),
      );
    } finally {
      refreshing = false;
    }
  }

  function singleHeaderAccount(group: UsageProviderGroup) {
    const subscriptionAccounts = group.accounts.filter((account) => account.status === "subscription");
    return subscriptionAccounts.length === 1 ? subscriptionAccounts[0]! : null;
  }

  function nextPoolRefill(group: UsageProviderGroup) {
    for (const window of group.windows) {
      if (window.members.length > 1 && window.nextRefill) {
        return window.nextRefill;
      }
    }
    return null;
  }

  function pooledAccountCount(group: UsageProviderGroup): number {
    return group.accounts.filter((account) => account.status === "subscription").length;
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Proper filter menus on the left; display mode and manual refresh on the right. -->
  <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
    <div class="flex flex-wrap items-center gap-2">
      {#if connectedHosts.length > 0}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                disabled={connectedHosts.length <= 1}
                class="flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2.5 text-xs transition-colors hover:bg-(--wash-1) focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-75"
              >
                <ListFilterIcon size={13} class="shrink-0 text-muted-foreground" />
                <span class="text-muted-foreground">Host</span>
                <span class="font-medium text-foreground">
                  {hostFilterSummary(selectedHostIds, connectedHosts)}
                </span>
                {#if connectedHosts.length > 1}
                  <ChevronDownIcon size={12} class="shrink-0 text-muted-foreground" />
                {/if}
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          {#if connectedHosts.length > 1}
            <DropdownMenu.Content align="start" class="w-56">
              <DropdownMenu.CheckboxItem
                checked={selectedHostIds.size === 0}
                closeOnSelect={false}
                onCheckedChange={() => selectedHostIds.clear()}
              >
                <span class="min-w-0 flex-1 truncate">All hosts</span>
                <span class="text-xs tabular-nums text-muted-foreground">{connectedHosts.length}</span>
              </DropdownMenu.CheckboxItem>
              <DropdownMenu.Separator />
              {#each connectedHosts as host (host.serverId)}
                <DropdownMenu.CheckboxItem
                  checked={selectedHostIds.has(host.serverId)}
                  closeOnSelect={false}
                  onCheckedChange={() => toggleHostFilter(host.serverId)}
                >
                  <span class="min-w-0 flex-1 truncate">{host.label}</span>
                  {#if staleOrFailedHostSet.has(host.label)}
                    <span
                      class="size-1.5 shrink-0 rounded-full bg-(--solus-art-2)"
                      aria-label="Stale or failed"
                    ></span>
                  {/if}
                </DropdownMenu.CheckboxItem>
              {/each}
            </DropdownMenu.Content>
          {/if}
        </DropdownMenu.Root>
      {/if}

      {#if rawOverview.providers.length > 1}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2.5 text-xs transition-colors hover:bg-(--wash-1) focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span class="text-muted-foreground">Harness</span>
                <span class="font-medium text-foreground">
                  {harnessFilterSummary(selectedProviders, rawOverview.providers)}
                </span>
                <ChevronDownIcon size={12} class="shrink-0 text-muted-foreground" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" class="w-56">
            <DropdownMenu.CheckboxItem
              checked={selectedProviders.size === 0}
              closeOnSelect={false}
              onCheckedChange={() => selectedProviders.clear()}
            >
              <span class="min-w-0 flex-1 truncate">All harnesses</span>
            </DropdownMenu.CheckboxItem>
            <DropdownMenu.Separator />
            {#each rawOverview.providers as group (group.provider)}
              <DropdownMenu.CheckboxItem
                checked={selectedProviders.has(group.provider)}
                closeOnSelect={false}
                onCheckedChange={() => toggleProviderFilter(group.provider)}
              >
                <UsageProviderIcon provider={group.provider} size={14} />
                <span class="min-w-0 flex-1 truncate">{group.label}</span>
              </DropdownMenu.CheckboxItem>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex h-7.5 cursor-pointer items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2.5 text-xs transition-colors hover:bg-(--wash-1) focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span class="text-muted-foreground">State</span>
              <span class="font-medium text-foreground">{usageStateLabel(stateFilter)}</span>
              <ChevronDownIcon size={12} class="shrink-0 text-muted-foreground" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" class="w-48">
          <DropdownMenu.RadioGroup
            value={stateFilter}
            onValueChange={(value) => (stateFilter = value as UsageStateFilter)}
          >
            {#each USAGE_STATE_OPTIONS as option (option.value)}
              <DropdownMenu.RadioItem value={option.value}>
                {option.label}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {#if hasActiveFilters}
        <button
          type="button"
          onclick={clearAllFilters}
          class="inline-flex h-7.5 cursor-pointer items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <XIcon size={12} />
          Clear
        </button>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2.5">
      <div class="flex items-center gap-2">
        <span class="hidden text-xs text-muted-foreground @min-[40rem]/pane:inline">Show</span>
        <div
          role="radiogroup"
          aria-label="Show usage as"
          class="inline-flex items-center rounded-lg border border-border/80 bg-background p-0.5"
        >
          <button
            type="button"
            role="radio"
            aria-checked={displayMode === "remaining"}
            onclick={() => setDisplayMode("remaining")}
            class="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring {displayMode === 'remaining' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}"
          >
            Left
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={displayMode === "used"}
            onclick={() => setDisplayMode("used")}
            class="cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring {displayMode === 'used' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}"
          >
            Used
          </button>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        class="pointer-coarse:min-h-11"
        disabled={refreshing || activeHostEntries.length === 0}
        onclick={() => void refreshAll()}
        title={latestCheckedLabel ? `Last updated ${latestCheckedLabel}` : "Refresh usage limits"}
      >
        <RefreshCwIcon size={14} class={refreshing ? "animate-spin motion-reduce:animate-none" : ""} />
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
    </div>
  </div>

  {#if connectedHosts.length === 0}
    <UsageCallout kind="info">
      {#snippet children()}
        Connect a host to view remaining subscription quota and pace for your harnesses.
      {/snippet}
      {#snippet action()}
        <button
          type="button"
          onclick={() => workspace.selectSettingsTab("api-access")}
          class="cursor-pointer text-[13px] font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Open Hosts
        </button>
      {/snippet}
    </UsageCallout>
  {:else if rawOverview.providers.length === 0 && rawOverview.loadingHosts.length > 0}
    <UsageCallout kind="info" role="status">
      {#snippet children()}
        Reading subscription limits from {rawOverview.loadingHosts.join(", ")}…
      {/snippet}
    </UsageCallout>
  {:else if rawOverview.providers.length === 0}
    <UsageCallout kind="note">
      {#snippet children()}
        No connected harness reports subscription limits on the selected hosts.
      {/snippet}
      {#snippet action()}
        <button
          type="button"
          onclick={() => workspace.selectSettingsTab("providers")}
          class="cursor-pointer text-[13px] font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Open Providers
        </button>
      {/snippet}
    </UsageCallout>
  {:else if sectionProviders.length === 0 && nonMeteredNotices.length === 0}
    <UsageCallout kind="info">
      {#snippet children()}
        No usage windows match the current filters.
      {/snippet}
      {#snippet action()}
        <button
          type="button"
          onclick={clearAllFilters}
          class="cursor-pointer text-[13px] font-medium text-(--solus-accent) hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Clear filters
        </button>
      {/snippet}
    </UsageCallout>
  {:else}
    <!-- Open editorial harness sections separated by hairlines (no grey cards). -->
    {#each sectionProviders as group (group.provider)}
      {@const windowGroups = groupUsageWindowsByModelGroup(group.windows)}
      {@const hasModelGroups = windowGroups.length > 1 && windowGroups.every((section) => section.groupLabel !== null)}
      {@const headerAccount = singleHeaderAccount(group)}
      {@const pooledCount = pooledAccountCount(group)}
      {@const refillBadge = nextPoolRefill(group)}
      {@const unsupportedAccount = group.windows.length === 0 ? unsupportedAccountOf(group) : null}

      <section class="flex flex-col gap-5 border-b border-border/60 pb-6 last-of-type:border-b-0">
        <!-- Harness header with official provider icon -->
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2.5">
            <UsageProviderIcon provider={group.provider} size={18} />
            <h2 class="text-base font-semibold tracking-[-0.01em] text-foreground">
              {group.label}
            </h2>

            {#if unsupportedAccount}
              <span class="rounded-full border border-border px-2 py-px text-[11px] font-medium text-muted-foreground">
                Unavailable
              </span>
              {#if showHostNames && unsupportedAccount.hosts.length > 0}
                <span class="text-xs text-muted-foreground">
                  · {unsupportedAccount.hosts.map((host) => host.label).join(", ")}
                </span>
              {/if}
            {:else if pooledCount > 1}
              <span class="text-xs text-muted-foreground">
                {pooledCount} accounts pooled · weighted by plan
              </span>
            {:else if hasModelGroups}
              <span class="text-xs text-muted-foreground">
                {windowGroups.length} model groups{#if headerAccount && showHostNames && headerAccount.hosts.length > 0}
                  · {headerAccount.hosts.map((host) => host.label).join(", ")}
                {/if}
              </span>
            {:else if headerAccount}
              {#if headerAccount.planType}
                <span class="rounded-full border border-border px-2 py-px text-[11px] font-medium text-muted-foreground">
                  {headerAccount.planType}
                </span>
              {/if}
              {#if headerAccount.email}
                <UsageAccountEmail email={headerAccount.email} />
              {/if}
              {#if showHostNames && headerAccount.hosts.length > 0}
                <span class="text-xs text-muted-foreground">
                  · {headerAccount.hosts.map((host) => host.label).join(", ")}
                </span>
              {/if}
            {/if}
          </div>

          {#if refillBadge}
            <span
              class="rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums text-(--solus-art-positive)"
              style="background-color: color-mix(in oklch, var(--solus-art-positive) 12%, transparent);"
              title="Next scheduled pool refill"
            >
              ↻ +{refillBadge.restoresPercent}% <UsageResetTimer resetsAt={refillBadge.at} verb="" />
            </span>
          {/if}
        </div>

        {#if unsupportedAccount}
          <div class="flex flex-col gap-3 @min-[36rem]/pane:flex-row @min-[36rem]/pane:items-center @min-[36rem]/pane:gap-7">
            <div class="flex shrink-0 flex-col gap-0.5 @min-[36rem]/pane:w-37">
              <span class="text-xs font-medium text-muted-foreground">Quota</span>
              <span
                class="text-[30px] leading-[34px] font-semibold tracking-[-0.03em] text-muted-foreground/50 select-none"
                aria-hidden="true"
              >
                —
              </span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <div class="flex h-4.5 items-center" aria-hidden="true">
                <div class="h-2.5 w-full rounded-full border border-dashed border-border/80 bg-(--wash-1)/50"></div>
              </div>
              <p class="text-xs text-muted-foreground">
                {usageUnsupportedMessage(group.provider)}
              </p>
            </div>
          </div>
        {:else if hasModelGroups}
          <!-- 2-column hairline-split grid for multi-model-group harnesses (e.g. Google Antigravity) -->
          <div class="grid grid-cols-1 gap-6 @min-[40rem]/pane:grid-cols-2 @min-[40rem]/pane:gap-0">
            {#each windowGroups as section, index (section.groupId ?? index)}
              <div
                class={index % 2 === 1
                  ? "@min-[40rem]/pane:border-l @min-[40rem]/pane:border-border/60 @min-[40rem]/pane:pl-7"
                  : "@min-[40rem]/pane:pr-7"}
              >
                <UsageModelGroupPanel
                  {section}
                  providerLabel={group.label}
                  {displayMode}
                />
              </div>
            {/each}
          </div>
        {:else}
          <div class="flex flex-col gap-5">
            {#each windowGroups as section (section.groupId ?? "__default__")}
              {#if section.groupLabel}
                <span class="text-xs font-medium text-muted-foreground">{section.groupLabel}</span>
              {/if}
              {#each section.windows as window (window.id)}
                <UsageWindowCard
                  {window}
                  providerLabel={group.label}
                  {displayMode}
                  {showHostNames}
                  hideSingleAccountMeta={headerAccount !== null}
                />
              {/each}
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  {/if}

  <!-- Unboxed semantic callout bands for warnings (failed/stale hosts) and notes (signed-out / API accounts). -->
  {#if rawOverview.failedHosts.length > 0 || rawOverview.staleHosts.length > 0 || nonMeteredNotices.length > 0}
    <div class="flex flex-col">
      {#each rawOverview.failedHosts as failure (failure.serverId)}
        <UsageCallout kind="warning">
          {#snippet children()}
            <span class="font-medium text-foreground">{failure.label}</span>: {failure.message}
          {/snippet}
          {#snippet action()}
            <button
              type="button"
              disabled={refreshing}
              onclick={() => void refreshAll()}
              class="cursor-pointer text-[13px] font-medium text-(--solus-accent) hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              Retry
            </button>
          {/snippet}
        </UsageCallout>
      {/each}

      {#if rawOverview.staleHosts.length > 0}
        <UsageCallout kind="warning">
          {#snippet children()}
            {rawOverview.staleHosts.join(", ")} could not refresh limits. Showing last known values{#if latestCheckedLabel} from {latestCheckedLabel}{/if}.
          {/snippet}
          {#snippet action()}
            <button
              type="button"
              disabled={refreshing}
              onclick={() => void refreshAll()}
              class="cursor-pointer text-[13px] font-medium text-(--solus-accent) hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              Retry
            </button>
          {/snippet}
        </UsageCallout>
      {/if}

      {#each nonMeteredNotices as item (item.account.key)}
        {@const account = item.account}
        {@const command = signInCommand(account.provider)}
        {@const checkedAt = account.stale ? formatCheckedAt(account.fetchedAt) : null}
        {@const hostSuffix =
          showHostNames && account.hosts.length > 0
            ? ` on ${account.hosts.map((host) => host.label).join(", ")}`
            : ""}
        <UsageCallout kind={account.status === "unavailable" ? "warning" : "note"}>
          {#snippet children()}
            <span class="font-medium text-foreground">
              {account.displayName}{hostSuffix}
            </span>
            {#if account.email}
              <span class="ml-1.5 inline-block"><UsageAccountEmail email={account.email} /></span>
            {/if}
            {#if account.status === "api"}
              <span class="text-muted-foreground">
                uses metered API billing. Subscription quota windows do not apply.
              </span>
            {:else if account.status === "signed_out"}
              <span class="text-muted-foreground">
                is signed out.{#if command}
                  Run <code class="font-mono text-xs text-foreground">{command}</code> or sign in under Providers.
                {:else}
                  Sign in under Providers.
                {/if}
              </span>
            {:else}
              <span class="text-muted-foreground">
                could not read subscription limits.{#if checkedAt} Last checked {checkedAt}.{/if}
              </span>
            {/if}
          {/snippet}
          {#snippet action()}
            {#if account.status === "signed_out"}
              <button
                type="button"
                onclick={() => workspace.selectSettingsTab("providers")}
                class="cursor-pointer text-[13px] font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                Sign in
              </button>
            {:else if account.status === "unavailable"}
              <button
                type="button"
                disabled={refreshing}
                onclick={() => void refreshAll()}
                class="cursor-pointer text-[13px] font-medium text-(--solus-accent) hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
              >
                Retry
              </button>
            {/if}
          {/snippet}
        </UsageCallout>
      {/each}
    </div>
  {/if}
</div>
