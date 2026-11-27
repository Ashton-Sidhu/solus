<script lang="ts">
  import { untrack } from "svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { buildingVersion } from "@solus/client-core/app-versions";
  import { serversStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import OverviewAbout from "./overview/OverviewAbout.svelte";
  import OverviewAccess from "./overview/OverviewAccess.svelte";
  import OverviewDay from "./overview/OverviewDay.svelte";
  import OverviewOperations from "./overview/OverviewOperations.svelte";
  import OverviewProblems from "./overview/OverviewProblems.svelte";
  import OverviewSource from "./overview/OverviewSource.svelte";
  import OverviewStatus from "./overview/OverviewStatus.svelte";
  import OverviewTopline from "./overview/OverviewTopline.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { OVERVIEW_EMPTY } from "./lib/section-empty";
  import { Button } from "../../ui/button";
  import type { AppProblem } from "../lib/app-view";
  import { isHostUnreachable } from "../../../lib/sessionUtils";

  /**
   * The first section of the Manage page (docs/plans/apps.md §9.2). Top to
   * bottom: whether the app runs and its commands, what needs the owner, how
   * its last day went, its operations beside its status, then what the owner
   * calls it, where its source is, and what it may use. Delete is last.
   * Nothing here is a card: each part sits plain on the page.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    state: AppState | undefined;
    problems: AppProblem[];
    busy: boolean;
    pinned: boolean;
    onSelectSection: (section: AppManageSection) => void;
    onToggleStopped: () => void;
    onTogglePinned: () => void;
    /** Absent for an app with no UI. */
    onOpenApp?: () => void;
    onDelete: () => void;
  }
  let { serverId, app, state: appState, problems, busy, pinned, onSelectSection, onToggleStopped, onTogglePinned, onOpenApp, onDelete }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releases = [
        appsStore.metrics.watch(hostId, appId),
        // The versions also say whether the host builds one now.
        appsStore.versions.watch(hostId, appId),
        appsStore.schedules.watch(hostId, appId),
        appsStore.sessions.watch(hostId, appId),
      ];
      return () => releases.forEach((release) => release());
    });
  });
  const metrics = $derived(appsStore.metrics.get(serverId, app.id));
  const versions = $derived(appsStore.versions.get(serverId, app.id));
  const building = $derived(buildingVersion(versions ?? []));
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? serverId);
  const hostUnreachable = $derived(isHostUnreachable(serversStore.readinessFor(serverId).readiness));

  /** The Activity section opens on the failed calls: its filter is the call log's query. */
  function showFailures() {
    void appsStore.calls.load(serverId, app.id, { outcome: "failed" });
    onSelectSection("activity");
  }
</script>

<div class="flex flex-col gap-8" data-testid="app-overview">
  <OverviewTopline {app} {hostLabel} {building} runtime={appState?.runtime ?? null} isHostUnreachable={hostUnreachable} {busy} {pinned} {onToggleStopped} {onTogglePinned} {onOpenApp} />

  {#if problems.length > 0}
    <OverviewProblems {serverId} {app} {problems} {onSelectSection} />
  {/if}

  <!-- An app with no version and no build has no day and no status to show: the empty state says how to start it. -->
  <ManageSectionState
    {serverId}
    {app}
    count={app.activeVersion === null && building === null ? 0 : 1}
    error={null}
    empty={{ ...OVERVIEW_EMPTY, actions: [{ label: "Open Versions", run: () => onSelectSection("versions") }] }}
    onRetry={() => {}}
  >
    <OverviewDay {serverId} {app} {metrics} onShowFailures={showFailures} />

    <div class="flex items-start gap-10 @max-[56rem]/pane:flex-col @max-[56rem]/pane:gap-8">
      <OverviewOperations {serverId} {app} {metrics} {versions} {onSelectSection} />
      <OverviewStatus {serverId} {app} state={appState} {versions} {building} {onSelectSection} />
    </div>
  </ManageSectionState>

  <!-- Three plain columns, set apart by space, not a rule. They stack when the pane is narrow. -->
  <div class="grid grid-cols-3 gap-6 pt-4 @max-[56rem]/pane:grid-cols-1 @max-[56rem]/pane:gap-8">
    <OverviewAbout {serverId} {app} />
    <OverviewSource {serverId} {app} state={appState} {onSelectSection} />
    <OverviewAccess {serverId} {app} state={appState} />
  </div>

  <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
    <p class="m-0 text-[13px] text-(--solus-text-tertiary)">Delete removes the versions, the data, the files, the secrets, the schedules, and the webhooks. The sessions stay. You cannot undo this.</p>
    <Button size="sm" variant="ghost" class="text-[13px] font-medium text-(--failure) hover:text-(--failure)" disabled={busy} onclick={onDelete} data-testid="app-overview-delete">Delete app…</Button>
  </div>
</div>
