<script lang="ts">
  import { untrack } from "svelte";
  import { changeLog, deployHistory, liveState } from "@solus/client-core/app-versions";
  import type { AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import DeployHistory from "./DeployHistory.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { VERSIONS_EMPTY } from "./lib/section-empty";
  import RevisionChangeLog from "./RevisionChangeLog.svelte";
  import VersionChangeCard from "./VersionChangeCard.svelte";
  import VersionStatus from "./VersionStatus.svelte";
  import { VersionActions } from "./lib/version-actions.svelte";

  /**
   * The Versions section (docs/plans/apps.md §9.2). A save makes a revision; a
   * deploy builds a revision into a version and makes it active; a rollback
   * makes an earlier version active again. The history is on the left; the
   * save it selects is plain on the right, with what a deploy of it changes
   * and its diff. The deploys are under them.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Opens another section: "Set it" of a secret the save needs opens Secrets. */
    onSelectSection?: (section: AppManageSection) => void;
  }
  let { serverId, app, onSelectSection }: Props = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => {
      const releaseRevisions = appsStore.revisions.watch(hostId, appId);
      const releaseVersions = appsStore.versions.watch(hostId, appId);
      return () => {
        releaseRevisions();
        releaseVersions();
      };
    });
  });
  const revisions = $derived(appsStore.revisions.get(serverId, app.id));
  const versions = $derived(appsStore.versions.get(serverId, app.id));
  const error = $derived(appsStore.revisions.errorFor(serverId, app.id) ?? appsStore.versions.errorFor(serverId, app.id));
  const live = $derived(revisions && versions ? liveState(revisions, versions) : undefined);
  const entries = $derived(revisions && versions ? changeLog(revisions, versions) : []);
  const events = $derived(versions ? deployHistory(versions) : []);

  const actions = new VersionActions(() => ({ serverId, appId: app.id }));
  // One build at a time: a deploy from this page, or a version that another deploy builds.
  const isDeploying = $derived(actions.deployingCommit !== null || (live?.building ?? null) !== null);

  let chosenCommit = $state<string | null>(null);
  // The save that opens first: the newest one that does not run, else the live one.
  const selected = $derived(entries.find((entry) => entry.revision.commit === chosenCommit) ?? entries.find((entry) => entry.position === "ahead") ?? entries.find((entry) => entry.position === "live") ?? entries[0] ?? null);

  let now = $state(Date.now());
  $effect(() => messageTimestampClock.subscribe((value) => (now = value)));

  function reload() {
    void appsStore.revisions.load(serverId, app.id);
    void appsStore.versions.load(serverId, app.id);
  }
</script>

{#if live === undefined || entries.length === 0}
  <ManageSectionState {serverId} {app} count={live === undefined ? undefined : 0} {error} empty={VERSIONS_EMPTY} onRetry={reload}>
    {#snippet children()}{/snippet}
  </ManageSectionState>
{:else}
  <div class="flex min-w-0 flex-col gap-5" data-testid="app-timeline">
    <VersionStatus {serverId} appId={app.id} {live} {actions} {isDeploying} />

    <div class="flex min-w-0 items-start gap-5.5 @max-[48rem]/pane:flex-col @max-[48rem]/pane:items-stretch">
      <section class="flex w-82.5 shrink-0 flex-col @max-[48rem]/pane:w-full" aria-label="History">
        <h3 class="m-0 px-3 pb-2 text-[15px] leading-5 font-semibold text-foreground">History</h3>
        <RevisionChangeLog
          {entries}
          selectedCommit={selected?.revision.commit ?? null}
          onSelect={(commit) => (chosenCommit = commit)}
          liveVersion={live.live?.number ?? null}
          {isDeploying}
          {actions}
          {now}
        />
      </section>
      {#if selected}
        {#key selected.revision.commit}
          <VersionChangeCard
            {serverId}
            appId={app.id}
            entry={selected}
            {live}
            {isDeploying}
            {actions}
            {now}
            onOpenSecrets={onSelectSection ? () => onSelectSection("secrets") : undefined}
          />
        {/key}
      {/if}
    </div>

    <section class="flex min-w-0 flex-col gap-2 pt-4" aria-label="Deploys">
      <h3 class="m-0 px-1 text-[15px] font-semibold text-foreground">Deploys <span class="font-normal text-(--solus-text-tertiary) tabular-nums">{events.length}</span></h3>
      {#if events.length === 0}
        <p class="m-0 px-1 text-sm text-muted-foreground">No deploy yet. Deploy a save from the history.</p>
      {:else}
        <DeployHistory {serverId} appId={app.id} {events} liveVersion={live.live?.number ?? null} {isDeploying} {actions} />
      {/if}
    </section>
  </div>
{/if}
