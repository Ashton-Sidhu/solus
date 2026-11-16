<script lang="ts">
  import { untrack } from "svelte";
  import { activationLabel, shortCommit, type AppChangeLogEntry, type AppLiveState } from "@solus/client-core/app-versions";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import { versionDiffFiles } from "../lib/app-version-diff";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import BuildLog from "./BuildLog.svelte";
  import DiffFiles from "./DiffFiles.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";
  import { diffTotals, historyMeta, preflightLines, versionFactsText } from "./lib/versions";

  /**
   * The save the history selected: the one card of the Versions section. Its
   * head says what it is against and holds its action (Deploy, or a rollback
   * or roll forward to the version built from it). "This deploy" is the
   * host's preflight: what a deploy of it changes against the live version.
   * The live save says what it may use and has its build log. Then the diff
   * of each file.
   */
  interface Props {
    serverId: string;
    appId: string;
    entry: AppChangeLogEntry;
    live: AppLiveState;
    isDeploying: boolean;
    actions: VersionActions;
    now: number;
    /** Opens the Secrets section, for a secret the revision needs. Absent: the line has no link. */
    onOpenSecrets?: () => void;
  }
  let { serverId, appId, entry, live, isDeploying, actions, now, onOpenSecrets }: Props = $props();

  const commit = $derived(entry.revision.commit);
  const liveVersion = $derived(live.live);
  const isLive = $derived(entry.position === "live");
  // A save that is not live is read against the live save: what a deploy or a rollback of it changes.
  const against = $derived(!isLive && liveVersion && liveVersion.revision !== commit ? liveVersion.revision : undefined);
  const diffKey = $derived([serverId, appId, commit, against ?? ""].join("\n"));
  const diff = $derived.by(() => {
    void diffKey;
    return untrack(() => appsStore.revisionDiff(serverId, appId, commit, against));
  });

  // The preflight builds a save that has no version: read it only for a save that is not live.
  $effect(() => {
    const hostId = serverId;
    const id = appId;
    const revision = isLive ? null : commit;
    if (!revision) return;
    return untrack(() => appsStore.deployPreflight.watch(hostId, id, revision));
  });
  const preflight = $derived(!isLive && appsStore.deployPreflight.queryFor(serverId, appId) === commit ? appsStore.deployPreflight.get(serverId, appId) : undefined);
  const preflightError = $derived(appsStore.deployPreflight.errorFor(serverId, appId));
  const confirmKey = $derived(`card:activate:${commit}`);
  const logKey = $derived(`card:log:${commit}`);
  const builtVersion = $derived(entry.versions[0] ?? null);
</script>

<article
  class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--hairline-strong)] bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] dark:shadow-none"
  aria-label="The save {entry.revision.message || shortCommit(commit)}"
  data-testid="app-version-change"
>
  <header class="flex min-w-0 flex-wrap items-center gap-3 pt-4 pr-4.5 pb-3.5 pl-5">
    <div class="flex min-w-48 flex-1 flex-col gap-0.75">
      <h3 class="m-0 line-clamp-2 text-base leading-5 font-semibold text-pretty text-foreground">{entry.revision.message || "No message"}</h3>
      <div class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-(--solus-text-tertiary)">
        {#await diff}
          <span>{against && liveVersion ? `Against live version ${liveVersion.number}` : historyMeta(entry, now)}</span>
        {:then answer}
          {@const totals = diffTotals(versionDiffFiles(answer.patch))}
          <span>
            {#if against && liveVersion}Against live version {liveVersion.number}{:else if answer.base === null}The first save{:else}Against the save before it{/if}
            · {totals.files === 1 ? "1 file" : `${totals.files} files`} ·
            <span class="tabular-nums text-(--solus-diff-added-text-vivid)">+{totals.additions}</span>
            <span class="tabular-nums text-(--solus-diff-removed-text-vivid)">−{totals.deletions}</span>
          </span>
        {:catch}
          <span>{historyMeta(entry, now)}</span>
        {/await}
        <span aria-hidden="true">·</span>
        <span class="inline-flex items-center gap-0.5 font-mono text-xs" title={commit}>{shortCommit(commit)}<CopyButton text={commit} title="Copy the revision" iconOnly refocusInput={false} /></span>
      </div>
    </div>
    {#if entry.canDeploy}
      <Button disabled={isDeploying} onclick={() => void actions.deploy(commit)} data-testid="app-revision-deploy">
        {actions.deployingCommit === commit ? "Deploying…" : entry.versions.length > 0 ? "Deploy again" : "Deploy"}
      </Button>
    {:else if entry.restorable && !isLive}
      <Button variant="outline" disabled={actions.isActivating || isDeploying} onclick={() => actions.askToActivate(confirmKey)} data-testid="app-revision-activate">
        {activationLabel(entry.restorable.number, liveVersion?.number ?? null)}
      </Button>
    {:else if isLive && builtVersion}
      <Button variant="outline" aria-expanded={actions.openDetail === logKey} onclick={() => actions.toggleDetail(logKey)}>
        {actions.openDetail === logKey ? "Hide the build log" : "Build log"}
      </Button>
    {/if}
  </header>

  {#if entry.restorable && !isLive}
    <div class="px-5 pb-3.5 empty:hidden">
      <ActivationConfirm {actions} rowKey={confirmKey} target={entry.restorable.number} live={liveVersion?.number ?? null} />
    </div>
  {/if}

  {#if isLive && builtVersion}
    <section class="flex flex-col gap-2 border-t border-[var(--hairline)] px-5 pt-3 pb-4" aria-label="What this version may use">
      <h4 class="m-0 text-[13px] font-semibold text-foreground">What it may use</h4>
      <p class="m-0 text-sm text-pretty text-foreground">{builtVersion.permissionsNotice ?? "Nothing outside its own data."}</p>
      <p class="m-0 text-xs text-(--solus-text-tertiary) tabular-nums">{versionFactsText(builtVersion)}</p>
      {#if actions.openDetail === logKey}
        <BuildLog {serverId} {appId} version={builtVersion.number} isBuilding={false} />
      {/if}
    </section>
  {:else}
    <section class="flex flex-col gap-2 border-t border-[var(--hairline)] px-5 pt-3 pb-4" aria-label="This deploy" data-testid="app-deploy-preflight">
      <h4 class="m-0 text-[13px] font-semibold text-foreground">{entry.canDeploy ? "This deploy" : "This rollback"}</h4>
      {#if preflight === undefined}
        {#if preflightError}
          <div class="flex flex-wrap items-center gap-2" role="alert">
            <span class="text-[13px] text-destructive">{preflightError}</span>
            <Button size="xs" variant="outline" onclick={() => void appsStore.deployPreflight.load(serverId, appId, commit)}>Try again</Button>
          </div>
        {:else}
          <p class="m-0 text-[13px] text-(--solus-text-tertiary)" role="status" aria-busy="true">
            {entry.versions.length > 0 ? "Reading what it declares…" : "The host builds the save to read what it declares. Nothing runs from it."}
          </p>
        {/if}
      {:else if preflight}
        {@const lines = preflightLines(preflight)}
        {#if lines.length === 0}
          <p class="m-0 text-sm text-(--solus-text-secondary)">It changes no permission, workflow, schedule, webhook, signal, or secret.</p>
        {:else}
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            {#each lines as line, index (index)}
              <li class="text-sm leading-4.5 text-pretty {line.sign === '!' ? 'text-(--warning)' : 'text-foreground'}">
                <span class={line.sign === "+" ? "text-(--success)" : line.sign === "−" ? "text-(--failure)" : ""} aria-hidden="true">{line.sign}</span>
                {line.text}{#if line.secret && onOpenSecrets}
                  · <button type="button" class="cursor-pointer border-0 bg-transparent p-0 text-sm text-inherit underline decoration-[color-mix(in_oklch,var(--warning)_40%,transparent)] underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]" onclick={onOpenSecrets}>Set it</button>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>
  {/if}

  <div class="border-t border-[var(--hairline)]">
    {#await diff}
      <p class="m-0 px-5 py-3 text-xs text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the changes…</p>
    {:then answer}
      <DiffFiles files={versionDiffFiles(answer.patch)} patch={answer.patch} truncated={answer.truncated} />
    {:catch error}
      <p class="m-0 px-5 py-3 text-xs text-destructive" role="alert">{error instanceof Error ? error.message : "Could not load the changes."}</p>
    {/await}
  </div>
</article>
