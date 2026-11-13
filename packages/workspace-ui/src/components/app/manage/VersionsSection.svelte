<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { attributionLabel } from "@solus/contracts/user";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { formatDuration } from "../../insights/lib/format";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import BuildLog from "./BuildLog.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import SourceChanges from "./SourceChanges.svelte";
  import { APP_ROLLBACK_NOTE, appTime, versionStateLabel } from "../lib/app-view";
  import { appTimeline, buildingVersion, canActivate, shortCommit } from "./lib/timeline";

  /**
   * The revisions and the versions of one app in one timeline, the newest
   * first (docs/plans/apps.md §9.2). A revision is one save; a version is one
   * build of a revision. The owner deploys a revision and makes a version active.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

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
  const timeline = $derived(revisions && versions ? appTimeline(revisions, versions) : undefined);
  const building = $derived(buildingVersion(versions ?? []));
  const error = $derived(appsStore.revisions.errorFor(serverId, app.id) ?? appsStore.versions.errorFor(serverId, app.id));

  /** What shows under one row: the source change of a revision or a version, or a version's build log. */
  let openDetail = $state<string | null>(null);
  /** The revision a deploy from this page builds now. The host answers only when the build ended. */
  let deployingCommit = $state<string | null>(null);
  let isActivating = $state(false);
  // One build at a time: a deploy from this page, or a version that another deploy builds.
  const isDeploying = $derived(deployingCommit !== null || building !== null);

  function toggleDetail(key: string) {
    openDetail = openDetail === key ? null : key;
  }

  function reload() {
    void appsStore.revisions.load(serverId, app.id);
    void appsStore.versions.load(serverId, app.id);
  }

  async function deploy(commit: string) {
    if (isDeploying) return;
    deployingCommit = commit;
    try {
      const receipt = await appsStore.deploy(serverId, app.id, commit);
      if (!receipt.active) toasts.error(`Version ${receipt.version} did not become active`, { description: receipt.error ?? "The version before it still runs." });
    } catch (cause) {
      toasts.error("The revision was not deployed", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      deployingCommit = null;
      requestInputFocus();
    }
  }

  async function makeActive(version: number) {
    if (isActivating) return;
    isActivating = true;
    try {
      await appsStore.activate(serverId, app.id, version);
    } catch (cause) {
      toasts.error("The version did not become active", { description: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      isActivating = false;
      requestInputFocus();
    }
  }
</script>

<ManageHeading title="Versions" description="A save makes a revision and changes nothing that runs. A deploy builds one revision on the host and makes the version active." />

{#if timeline === undefined}
  {#if error}
    <div class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{error}</span>
      <Button size="xs" variant="outline" onclick={reload}>Try again</Button>
    </div>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading…</p>
  {/if}
{:else if timeline.length === 0}
  <p class="m-0 text-sm text-muted-foreground">This app has no revision yet.</p>
{:else}
  {#if building || deployingCommit}
    <p class="m-0 pb-3 text-xs text-muted-foreground" role="status" data-testid="app-version-building">
      {building ? `The host builds version ${building.number} now.` : "The host builds a revision now."} You can leave this page: the build continues.
    </p>
  {/if}
  <p class="m-0 pb-3 text-xs text-muted-foreground">Make active: {APP_ROLLBACK_NOTE}</p>
  <ol class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-timeline">
    {#each timeline as entry (entry.commit)}
      {@const changesKey = `revision:${entry.commit}`}
      <li class="flex min-w-0 flex-col gap-2 rounded-xl border border-border/50 px-3 py-2.5" data-testid="app-revision">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <code class="shrink-0 font-mono text-xs text-(--solus-text-primary)" title={entry.commit}>{shortCommit(entry.commit)}</code>
          <CopyButton text={entry.commit} title="Copy the revision" iconOnly />
          <span class="min-w-24 flex-1 truncate text-sm" title={entry.message}>{entry.message || "No message"}</span>
          {#if entry.isNewest}
            <span class="shrink-0 text-xs text-muted-foreground">Newest revision</span>
          {/if}
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground" title={new Date(entry.savedAt).toLocaleString()}>Saved {appTime(entry.savedAt)}</span>
        </div>
        {#if entry.versions.length === 0}
          <p class="m-0 text-xs text-muted-foreground">{entry.isNewest ? "This revision waits for a deploy." : "No version was built from this revision."}</p>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" aria-expanded={openDetail === changesKey} onclick={() => toggleDetail(changesKey)}>
            {openDetail === changesKey ? "Hide changes" : "View changes"}
          </Button>
          {#if entry.canDeploy}
            <Button size="xs" disabled={isDeploying} onclick={() => void deploy(entry.commit)} data-testid="app-revision-deploy">
              {deployingCommit === entry.commit ? "Deploying…" : entry.versions.length > 0 ? "Deploy again" : "Deploy"}
            </Button>
          {/if}
        </div>
        {#if openDetail === changesKey}
          <SourceChanges {serverId} appId={app.id} subject={{ kind: "revision", commit: entry.commit }} />
        {/if}

        {#each entry.versions as version (version.number)}
          {@const logKey = `log:${version.number}`}
          {@const diffKey = `version:${version.number}`}
          <div class="flex min-w-0 flex-col gap-1.5 rounded-lg bg-[var(--wash-1)] px-3 py-2" data-testid="app-version">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="shrink-0 font-medium tabular-nums">v{version.number}</span>
              <span class="shrink-0 text-xs {version.state === 'failed' ? 'text-destructive' : version.state === 'active' ? 'text-foreground' : 'text-muted-foreground'}">{versionStateLabel(version.state)}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {version.operationCount === 1 ? "1 operation" : `${version.operationCount} operations`}{version.hasUi ? ", a UI" : ", no UI"} · protocol {version.protocol}{version.buildMs === null ? "" : ` · built in ${formatDuration(version.buildMs)}`}
              </span>
              <span class="shrink-0 text-xs text-muted-foreground">{attributionLabel(version.createdBy)} · {appTime(version.createdAt)}</span>
            </div>
            {#if version.error}
              <p class="m-0 text-xs text-destructive text-pretty">{version.error}</p>
            {/if}
            <p class="m-0 text-xs text-muted-foreground text-pretty">{version.permissionsNotice ?? "This version uses nothing outside its own data."}</p>
            <div class="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" aria-expanded={openDetail === logKey} onclick={() => toggleDetail(logKey)}>
                {openDetail === logKey ? "Hide the build log" : "Build log"}
              </Button>
              <Button size="xs" variant="outline" aria-expanded={openDetail === diffKey} onclick={() => toggleDetail(diffKey)}>
                {openDetail === diffKey ? "Hide changes" : "Changes from the version before"}
              </Button>
              {#if canActivate(version)}
                <Button size="xs" variant="outline" disabled={isActivating || isDeploying} onclick={() => void makeActive(version.number)}>Make active</Button>
              {/if}
            </div>
            {#if openDetail === logKey}
              <BuildLog {serverId} appId={app.id} version={version.number} isBuilding={version.state === "building"} />
            {:else if openDetail === diffKey}
              <SourceChanges {serverId} appId={app.id} subject={{ kind: "version", version: version.number }} />
            {/if}
          </div>
        {/each}
      </li>
    {/each}
  </ol>
{/if}
