<script lang="ts">
  import { untrack } from "svelte";
  import { activationLabel, shortCommit, type AppChangeLogEntry, type AppLiveState } from "@solus/client-core/app-versions";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import { versionDiffFiles } from "../lib/app-version-diff";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import BuildLog from "./BuildLog.svelte";
  import DiffFiles from "./DiffFiles.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";
  import { changeWhen, diffTotals, missingSecretsTail, preflightBuildError, preflightLines, versionFactsText } from "./lib/versions";

  /**
   * The save the history selected, plain on the page beside it: no card. Its
   * head says what it is against and holds its action (Deploy, or a rollback
   * or roll forward to the version built from it). "This deploy" is the
   * host's preflight, as plain facts: what a deploy of it changes against the
   * live version. A secret it needs with no value is a warning callout with
   * Set secret; a failed build is an error callout. The live save says what
   * it may use and has its build log. Then the diff of each file.
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

<article class="flex min-w-0 flex-1 flex-col gap-5 pt-1" aria-label="The save {entry.revision.message || shortCommit(commit)}" data-testid="app-version-change">
  <header class="flex min-w-0 flex-wrap items-start gap-3">
    <div class="flex min-w-48 flex-1 flex-col gap-1">
      <h3 class="m-0 line-clamp-2 text-[17px] leading-5.5 font-semibold text-pretty text-foreground">{entry.revision.message || "No message"}</h3>
      <p class="m-0 text-[13px] leading-4.5 text-(--solus-text-tertiary)" title={commit}>
        {changeWhen(entry, now)}
        {#await diff then answer}
          {@const totals = diffTotals(versionDiffFiles(answer.patch))}
          · {#if against && liveVersion}against live version {liveVersion.number}{:else if answer.base === null}the first save{:else}against the save before it{/if}
          · {totals.files === 1 ? "1 file" : `${totals.files} files`}
          <span class="tabular-nums text-(--solus-diff-added-text-vivid)">+{totals.additions}</span>
          <span class="tabular-nums text-(--solus-diff-removed-text-vivid)">−{totals.deletions}</span>
        {/await}
      </p>
    </div>
    {#if entry.canDeploy}
      <Button class="shrink-0" disabled={isDeploying} onclick={() => void actions.deploy(commit)} data-testid="app-revision-deploy">
        {actions.deployingCommit === commit ? "Deploying…" : entry.versions.length > 0 ? "Deploy again" : "Deploy"}
      </Button>
    {:else if entry.restorable && !isLive}
      <Button class="shrink-0" variant="outline" disabled={actions.isActivating || isDeploying} onclick={() => actions.askToActivate(confirmKey)} data-testid="app-revision-activate">
        {activationLabel(entry.restorable.number, liveVersion?.number ?? null)}
      </Button>
    {:else if isLive && builtVersion}
      <Button class="shrink-0" variant="outline" aria-expanded={actions.openDetail === logKey} onclick={() => actions.toggleDetail(logKey)}>
        {actions.openDetail === logKey ? "Hide the build log" : "Build log"}
      </Button>
    {/if}
  </header>

  {#if entry.restorable && !isLive}
    <div class="empty:hidden">
      <ActivationConfirm {actions} rowKey={confirmKey} target={entry.restorable.number} live={liveVersion?.number ?? null} />
    </div>
  {/if}

  {#if isLive && builtVersion}
    <section class="flex flex-col gap-1.5" aria-label="What this version may use">
      <h4 class="m-0 text-xs leading-4 font-normal text-(--solus-text-tertiary)">What it may use</h4>
      <p class="m-0 text-[13px] leading-4.75 text-pretty text-(--solus-text-secondary)">{builtVersion.permissionsNotice ?? "Nothing outside its own data."}</p>
      <p class="m-0 text-[13px] leading-4.75 text-(--solus-text-secondary) tabular-nums">{versionFactsText(builtVersion)}</p>
      {#if actions.openDetail === logKey}
        <BuildLog {serverId} {appId} version={builtVersion.number} isBuilding={false} />
      {/if}
    </section>
  {:else}
    <section class="flex flex-col gap-1.5" aria-label="This deploy" data-testid="app-deploy-preflight">
      <h4 class="m-0 text-xs leading-4 font-normal text-(--solus-text-tertiary)">{entry.canDeploy ? "This deploy" : "This rollback"}</h4>
      {#if preflight === undefined}
        {#if preflightError}
          <div class="text-[13px] [--prose-ink-strong:var(--solus-text-primary)]" role="alert">
            <MarkdownAlert alertType="error">
              {#snippet content()}
                <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span class="min-w-0 flex-1">{preflightError}</span>
                  <Button size="xs" variant="outline" onclick={() => void appsStore.deployPreflight.load(serverId, appId, commit)}>Try again</Button>
                </div>
              {/snippet}
            </MarkdownAlert>
          </div>
        {:else}
          <p class="m-0 text-[13px] leading-4.75 text-(--solus-text-tertiary)" role="status" aria-busy="true">
            {entry.versions.length > 0 ? "Reading what it declares…" : "The host builds the save to read what it declares. Nothing runs from it."}
          </p>
        {/if}
      {:else if preflight}
        {@const lines = preflightLines(preflight)}
        {@const buildError = preflightBuildError(preflight)}
        {#if buildError}
          <div class="text-[13px] [--prose-ink-strong:var(--solus-text-primary)]">
            <MarkdownAlert alertType="error">
              {#snippet content()}<span class="text-pretty">{buildError}</span>{/snippet}
            </MarkdownAlert>
          </div>
        {:else if lines.length === 0}
          <p class="m-0 text-[13px] leading-4.75 text-(--solus-text-secondary)">It changes no permission, workflow, schedule, webhook, signal, or secret.</p>
        {:else}
          <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
            {#each lines as line, index (index)}
              <li class="text-[13px] leading-4.75 text-pretty text-(--solus-text-secondary)">
                {line.words} <span class="text-foreground {line.isCode ? 'font-mono text-xs' : ''}">{line.name}</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </section>
    {#if preflight && preflight.secretsMissing.length > 0}
      <div class="text-[13px] [--prose-ink-strong:var(--solus-text-primary)]" data-testid="app-deploy-missing-secrets">
        <MarkdownAlert alertType="warning">
          {#snippet content()}
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span class="min-w-0 flex-1 text-pretty">
                Needs {#each preflight.secretsMissing as secret, index (secret.name)}{index > 0 ? (index === preflight.secretsMissing.length - 1 ? " and " : ", ") : ""}<span class="font-mono text-xs">{secret.name}</span>{/each}{missingSecretsTail(preflight.secretsMissing.length)}
              </span>
              {#if onOpenSecrets}
                <button
                  type="button"
                  class="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-foreground underline decoration-[color-mix(in_oklch,var(--foreground)_25%,transparent)] decoration-1 underline-offset-3 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
                  onclick={onOpenSecrets}>Set secret</button
                >
              {/if}
            </div>
          {/snippet}
        </MarkdownAlert>
      </div>
    {/if}
  {/if}

  {#await diff}
    <p class="m-0 text-xs text-(--solus-text-tertiary)" role="status" aria-busy="true">Loading the changes…</p>
  {:then answer}
    <DiffFiles files={versionDiffFiles(answer.patch)} patch={answer.patch} truncated={answer.truncated} />
  {:catch error}
    <div class="text-[13px] [--prose-ink-strong:var(--solus-text-primary)]" role="alert">
      <MarkdownAlert alertType="error">
        {#snippet content()}{error instanceof Error ? error.message : "Could not load the changes."}{/snippet}
      </MarkdownAlert>
    </div>
  {/await}
</article>
