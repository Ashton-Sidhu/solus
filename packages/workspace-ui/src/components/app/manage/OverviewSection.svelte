<script lang="ts">
  import { untrack } from "svelte";
  import { Play as StartIcon, Square as StopIcon } from "@lucide/svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { serversStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import { formatDuration } from "../../insights/lib/format";
  import { Button } from "../../ui/button";
  import * as Table from "../../ui/table";
  import ManageHeading from "./ManageHeading.svelte";
  import ProblemList from "./ProblemList.svelte";
  import { appTime, versionLabel, type AppProblem } from "../lib/app-view";
  import { appRunState, appRunStateLabel, failureRateText, hourBars, runtimeText } from "./lib/overview";
  import { buildingVersion } from "./lib/timeline";

  /**
   * The first section of the Manage page (docs/plans/apps.md §9.2): whether the
   * app runs, on which host, on which version; what needs the owner; the calls
   * of the last 24 hours; and what the app may use.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
    problems: AppProblem[];
    busy: boolean;
    onSelectSection: (section: AppManageSection) => void;
    onToggleStopped: () => void;
  }
  let { serverId, app, state: appState, problems, busy, onSelectSection, onToggleStopped }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseMetrics = appsStore.metrics.watch(hostId, appId);
      // The versions say whether the host builds one now.
      const releaseVersions = appsStore.versions.watch(hostId, appId);
      return () => {
        releaseMetrics();
        releaseVersions();
      };
    });
  });
  const metrics = $derived(appsStore.metrics.get(serverId, app.id));
  const metricsError = $derived(appsStore.metrics.errorFor(serverId, app.id));
  const building = $derived(buildingVersion(appsStore.versions.get(serverId, app.id) ?? []));
  const runState = $derived(appRunState(app));
  const bars = $derived(metrics ? hourBars(metrics.hours) : []);
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? serverId);
</script>

<ManageHeading title="Overview" description={app.description || undefined}>
  {#snippet actions()}
    {#if app.activeVersion !== null}
      <Button size="xs" variant="outline" disabled={busy} onclick={onToggleStopped} data-testid="app-overview-toggle-stopped">
        {#if app.stopped}
          <StartIcon size={12} /> Start
        {:else}
          <StopIcon size={12} /> Stop
        {/if}
      </Button>
    {/if}
  {/snippet}
</ManageHeading>

<div class="flex flex-col gap-6">
  <section class="flex flex-col gap-2" aria-label="State">
    <dl class="m-0 grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50 @max-[48rem]/pane:grid-cols-2" data-testid="app-overview-state">
      <div class="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2.5">
        <dt class="text-xs text-muted-foreground">State</dt>
        <dd class="m-0 flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span
            class="size-1.5 shrink-0 rounded-full {runState === 'running' ? 'bg-(--success)' : runState === 'building' ? 'bg-(--warning)' : 'bg-muted-foreground/50'}"
            aria-hidden="true"
          ></span>
          <span class="min-w-0 truncate">{appRunStateLabel(runState)}</span>
        </dd>
      </div>
      <div class="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2.5">
        <dt class="text-xs text-muted-foreground">Host</dt>
        <dd class="m-0 min-w-0 truncate text-sm font-medium" title={hostLabel}>{hostLabel}</dd>
      </div>
      <div class="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2.5">
        <dt class="text-xs text-muted-foreground">Active version</dt>
        <dd class="m-0 min-w-0 truncate text-sm font-medium tabular-nums">{versionLabel(app.activeVersion)}</dd>
      </div>
      <div class="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2.5">
        <dt class="text-xs text-muted-foreground">Last call</dt>
        <dd class="m-0 min-w-0 truncate text-sm font-medium">{app.lastCallAt === null ? "No calls yet" : appTime(app.lastCallAt)}</dd>
      </div>
    </dl>
    {#if app.stopped}
      <p class="m-0 text-xs text-muted-foreground">This app is stopped. No operation runs, no schedule fires, and no run continues.</p>
    {:else if appState}
      <p class="m-0 text-xs text-muted-foreground">{runtimeText(appState.runtime)}</p>
    {/if}
    {#if building}
      <p class="m-0 text-xs text-muted-foreground" role="status">The host builds version {building.number} now.</p>
    {/if}
    {#if app.hasUndeployedRevision}
      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-3 py-2" data-testid="app-overview-undeployed">
        <span class="min-w-40 flex-1 text-sm">A newer revision waits for a deploy.</span>
        <Button size="xs" variant="outline" onclick={() => onSelectSection("versions")}>Open Versions</Button>
      </div>
    {/if}
  </section>

  {#if problems.length > 0}
    <section class="flex flex-col gap-2" aria-label="Problems">
      <h3 class="m-0 text-sm font-medium">Problems</h3>
      <ProblemList {problems} onOpenSection={onSelectSection} />
    </section>
  {/if}

  <section class="flex flex-col gap-3" aria-label="The last 24 hours">
    <h3 class="m-0 text-sm font-medium">The last 24 hours</h3>
    {#if metrics}
      <dl class="m-0 grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50 @max-[48rem]/pane:grid-cols-2" data-testid="app-overview-metrics">
        <div class="flex flex-col gap-0.5 bg-background px-3 py-2.5">
          <dt class="text-xs text-muted-foreground">Calls</dt>
          <dd class="m-0 text-lg font-medium tabular-nums">{metrics.calls.toLocaleString()}</dd>
        </div>
        <div class="flex flex-col gap-0.5 bg-background px-3 py-2.5">
          <dt class="text-xs text-muted-foreground">Failed</dt>
          <dd class="m-0 flex items-baseline gap-1.5 text-lg font-medium tabular-nums {metrics.failed > 0 ? 'text-destructive' : ''}">
            {metrics.failed.toLocaleString()}
            <span class="text-xs font-normal text-muted-foreground">{failureRateText(metrics.calls, metrics.failed)}</span>
          </dd>
        </div>
        <div class="flex flex-col gap-0.5 bg-background px-3 py-2.5">
          <dt class="text-xs text-muted-foreground">Median time</dt>
          <dd class="m-0 text-lg font-medium tabular-nums">{formatDuration(metrics.p50Ms)}</dd>
        </div>
        <div class="flex flex-col gap-0.5 bg-background px-3 py-2.5">
          <dt class="text-xs text-muted-foreground">95th percentile</dt>
          <dd class="m-0 text-lg font-medium tabular-nums">{formatDuration(metrics.p95Ms)}</dd>
        </div>
      </dl>

      {#if metrics.calls > 0}
        <div class="flex flex-col gap-1">
          <ol class="m-0 flex h-16 list-none items-end gap-px p-0" aria-label="Calls in each of the last 24 hours" data-testid="app-overview-hours">
            {#each bars as bar (bar.start)}
              <li
                class="flex h-full min-w-0 flex-1 flex-col justify-end"
                title="{new Date(bar.start).toLocaleTimeString([], { hour: 'numeric' })}: {bar.calls} {bar.calls === 1 ? 'call' : 'calls'}, {bar.failed} failed"
              >
                {#if bar.calls === 0}
                  <span class="h-px w-full bg-border" aria-hidden="true"></span>
                {:else}
                  <span class="flex w-full flex-col justify-end overflow-hidden rounded-t-xs bg-[color-mix(in_oklch,var(--foreground)_28%,transparent)]" style="height:{bar.heightPercent}%" aria-hidden="true">
                    <span class="w-full bg-destructive" style="height:{bar.heightPercent === 0 ? 0 : (bar.failedPercent / bar.heightPercent) * 100}%"></span>
                  </span>
                {/if}
              </li>
            {/each}
          </ol>
          <div class="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
            <span>24 hours ago</span>
            <span>Now</span>
          </div>
        </div>

        <Table.Root data-testid="app-overview-operations">
          <Table.Header>
            <Table.Row>
              <Table.Head>Operation</Table.Head>
              <Table.Head class="text-right">Calls</Table.Head>
              <Table.Head class="text-right">Failed</Table.Head>
              <Table.Head class="text-right">Median</Table.Head>
              <Table.Head class="text-right">95th</Table.Head>
              <Table.Head class="text-right">Last call</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each metrics.operations as operation (operation.operation)}
              <Table.Row>
                <Table.Cell class="max-w-48 truncate font-mono text-xs">{operation.operation}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{operation.calls.toLocaleString()}</Table.Cell>
                <Table.Cell class="text-right tabular-nums {operation.failed > 0 ? 'text-destructive' : ''}">{operation.failed.toLocaleString()}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{formatDuration(operation.p50Ms)}</Table.Cell>
                <Table.Cell class="text-right tabular-nums">{formatDuration(operation.p95Ms)}</Table.Cell>
                <Table.Cell class="text-right whitespace-nowrap text-muted-foreground">{operation.lastAt === null ? "—" : appTime(operation.lastAt)}</Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
        <Button size="xs" variant="link" class="self-start px-0" onclick={() => onSelectSection("activity")}>Open the call log in Activity</Button>
      {:else}
        <p class="m-0 text-sm text-muted-foreground">No operation of this app ran in the last 24 hours.</p>
      {/if}
    {:else if metricsError}
      <div class="flex flex-wrap items-center gap-2" role="alert">
        <span class="text-sm text-destructive">{metricsError}</span>
        <Button size="xs" variant="outline" onclick={() => void appsStore.metrics.load(serverId, app.id)}>Try again</Button>
      </div>
    {:else}
      <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading…</p>
    {/if}
  </section>

  <section class="flex flex-col gap-2" aria-label="What the app may use">
    <h3 class="m-0 text-sm font-medium">What the app may use</h3>
    {#if appState}
      <p class="m-0 text-sm text-muted-foreground text-pretty" data-testid="app-overview-permissions">
        {appState.permissionsNotice ?? "This app uses nothing outside its own data."}
      </p>
      {#if appState.roles.length > 0}
        <ul class="m-0 flex list-none flex-col gap-1 p-0" aria-label="Integrations">
          {#each appState.roles as role (role.slug)}
            <li class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
              <code class="min-w-0 truncate font-mono">{role.slug}</code>
              <span class="{role.connected ? 'text-muted-foreground' : 'text-(--warning)'}">
                {role.name === null ? "You have no integration with this name" : role.connected ? `${role.name}, connected` : `${role.name}, not connected`}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      {@const stateError = appsStore.stateErrorFor(serverId, app.id)}
      {#if stateError}
        <div class="flex flex-wrap items-center gap-2" role="alert">
          <span class="text-sm text-destructive">{stateError}</span>
          <Button size="xs" variant="outline" onclick={() => void appsStore.loadState(serverId, app.id)}>Try again</Button>
        </div>
      {:else}
        <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading…</p>
      {/if}
    {/if}
  </section>
</div>
