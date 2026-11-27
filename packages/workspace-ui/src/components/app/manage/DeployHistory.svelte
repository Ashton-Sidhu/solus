<script lang="ts">
  import { Redo2 as RollForwardIcon, Undo2 as RollbackIcon, Upload as DeployIcon } from "@lucide/svelte";
  import { activationLabel, canActivate, deployEventDetail, deployEventTitle, shortCommit, type AppDeployEvent } from "@solus/client-core/app-versions";
  import { attributionLabel } from "@solus/contracts/user";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import { appTime } from "../lib/app-view";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import BuildLog from "./BuildLog.svelte";
  import SourceChanges from "./SourceChanges.svelte";
  import StateIcon from "./StateIcon.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";

  /**
   * The deploy history: what ran when, the newest first. Each deploy, each
   * rollback and roll forward with who did it and the version it moved from,
   * and each build that failed. A rollback opens the source change it made:
   * the revision it left against the revision it went back to.
   */
  interface Props {
    serverId: string;
    appId: string;
    events: AppDeployEvent[];
    liveVersion: number | null;
    isDeploying: boolean;
    actions: VersionActions;
  }
  let { serverId, appId, events, liveVersion, isDeploying, actions }: Props = $props();
</script>

<section aria-label="Deploys" data-testid="app-deploy-history">
  <ol class="m-0 flex list-none flex-col p-0">
    {#each events as event (`${event.kind}:${event.version.number}:${event.at}`)}
      {@const key = `deploy:${event.kind}:${event.version.number}:${event.at}`}
      {@const isActivation = event.kind === "deploy" || event.kind === "rollback" || event.kind === "roll-forward"}
      {@const comparesRevisions = event.previousRevision !== null && event.previousRevision !== event.version.revision}
      <li class="flex min-w-0 flex-col gap-2.5 border-t border-[var(--hairline)] px-1 py-3.5 first:border-t-0" data-testid="app-deploy-event" data-kind={event.kind}>
        <div class="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
          <!-- What happened, as its mark: a build in progress and a build that failed take the state mark; a deploy, a rollback, and a roll forward take their kind, in ink. -->
          <span class="mt-0.5 flex shrink-0 text-muted-foreground">
            {#if event.kind === "failed"}
              <StateIcon state="failed" label="The build failed" />
            {:else if event.kind === "building"}
              <StateIcon state="running" label="Building" />
            {:else if event.kind === "rollback"}
              <RollbackIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            {:else if event.kind === "roll-forward"}
              <RollForwardIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            {:else}
              <DeployIcon size={16} strokeWidth={1.75} aria-hidden="true" />
            {/if}
          </span>
          <div class="flex min-w-48 flex-1 flex-col gap-1">
            <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span class="text-sm font-medium text-foreground">{deployEventTitle(event)}</span>
              {#if event.isLive}
                <span class="inline-flex" title="Live"><StateIcon state="ok" label="Live" size={14} /></span>
              {/if}
              <span class="text-xs text-(--solus-text-secondary)" title={new Date(event.at).toLocaleString()}>
                {attributionLabel(event.by)} · {appTime(event.at)}
              </span>
            </div>
            {#if event.kind === "failed"}
              <MarkdownAlert alertType="error">
                {#snippet content()}
                  <p class="m-0 text-[13px] text-pretty text-foreground select-text">{deployEventDetail(event)}</p>
                {/snippet}
              </MarkdownAlert>
            {:else}
              <span class="text-[13px] text-pretty text-(--solus-text-secondary)">{deployEventDetail(event)}</span>
            {/if}
            <span class="truncate text-xs text-(--solus-text-secondary)" title={event.version.message}>
              <span class="font-mono">{shortCommit(event.version.revision)}</span>
              {event.version.message ? ` ${event.version.message}` : ""}
            </span>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-1.5">
            {#if event.kind === "deploy" && canActivate(event.version)}
              <Button size="xs" variant="outline" disabled={actions.isActivating || isDeploying} onclick={() => actions.askToActivate(key)} data-testid="app-version-activate">
                {activationLabel(event.version.number, liveVersion)}
              </Button>
            {/if}
            {#if event.kind === "deploy" || (isActivation && comparesRevisions)}
              <Button size="xs" variant="ghost" aria-expanded={actions.openDetail === `${key}:changes`} onclick={() => actions.toggleDetail(`${key}:changes`)}>
                {actions.openDetail === `${key}:changes` ? "Hide changes" : "Changes"}
              </Button>
            {/if}
            {#if !isActivation || event.kind === "deploy"}
              <Button size="xs" variant="ghost" aria-expanded={actions.openDetail === `${key}:log`} onclick={() => actions.toggleDetail(`${key}:log`)}>
                {actions.openDetail === `${key}:log` ? "Hide the build log" : "Build log"}
              </Button>
            {/if}
          </div>
        </div>
        {#if event.kind === "deploy"}
          <ActivationConfirm {actions} rowKey={key} target={event.version.number} live={liveVersion} />
        {/if}
        {#if actions.openDetail === `${key}:changes`}
          {#if event.kind === "deploy"}
            <SourceChanges {serverId} {appId} subject={{ kind: "version", version: event.version.number }} />
          {:else if event.previousRevision}
            <SourceChanges {serverId} {appId} subject={{ kind: "revision", commit: event.version.revision, against: event.previousRevision }} />
          {/if}
        {:else if actions.openDetail === `${key}:log`}
          <BuildLog {serverId} {appId} version={event.version.number} isBuilding={event.kind === "building"} />
        {/if}
      </li>
    {/each}
  </ol>
</section>
