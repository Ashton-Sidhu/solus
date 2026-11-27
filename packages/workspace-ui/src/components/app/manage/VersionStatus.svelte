<script lang="ts">
  import { activationLabel, shortCommit, type AppLiveState } from "@solus/client-core/app-versions";
  import { Button } from "../../ui/button";
  import MarkdownAlert from "../../ui/MarkdownAlert.svelte";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import BuildLog from "./BuildLog.svelte";
  import StateIcon from "./StateIcon.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";

  /**
   * What stands between the live version and the history, plain above it: a
   * build in progress, with the working mark and its log, and a rollback, as a
   * note callout with the roll forward back to the newer build. With
   * neither, it draws nothing.
   */
  interface Props {
    serverId: string;
    appId: string;
    live: AppLiveState;
    actions: VersionActions;
    isDeploying: boolean;
  }
  let { serverId, appId, live: state, actions, isDeploying }: Props = $props();
</script>

{#if state.building}
  {@const building = state.building}
  <div class="flex min-w-0 flex-col gap-2 px-1" role="status" data-testid="app-version-building">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <StateIcon state="running" />
      <span class="min-w-48 flex-1 text-sm text-pretty">
        The host builds <span class="font-medium tabular-nums">v{building.number}</span> from revision
        <span class="font-mono text-xs">{shortCommit(building.revision)}</span>. You can leave this page: the build continues.
      </span>
      <Button size="sm" variant="outline" class="shrink-0" aria-expanded={actions.openDetail === "building:log"} onclick={() => actions.toggleDetail("building:log")}>
        {actions.openDetail === "building:log" ? "Hide the build log" : "Build log"}
      </Button>
    </div>
    {#if actions.openDetail === "building:log"}
      <BuildLog {serverId} {appId} version={building.number} isBuilding />
    {/if}
  </div>
{:else if actions.deployingCommit}
  <div class="flex min-w-0 items-center gap-3 px-1 text-sm" role="status" data-testid="app-version-building">
    <StateIcon state="running" />
    The host starts a build of revision <span class="font-mono text-xs">{shortCommit(actions.deployingCommit)}</span>.
  </div>
{/if}

{#if state.live && state.rolledBackFrom}
  {@const later = state.rolledBackFrom}
  {@const liveNumber = state.live.number}
  <div class="flex min-w-0 flex-col gap-2 text-[13px] [--prose-ink-strong:var(--solus-text-primary)]" data-testid="app-version-rolled-back">
    <MarkdownAlert alertType="note">
      {#snippet content()}
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span class="min-w-48 flex-1 text-pretty">
            Rolled back from <span class="tabular-nums">v{later.number}</span> to v{liveNumber}. The newer build is kept and can run again.
          </span>
          <Button size="xs" variant="outline" class="shrink-0" disabled={actions.isActivating || isDeploying} onclick={() => actions.askToActivate("live:forward")}>
            {activationLabel(later.number, liveNumber)}
          </Button>
        </div>
      {/snippet}
    </MarkdownAlert>
    <ActivationConfirm {actions} rowKey="live:forward" target={later.number} live={liveNumber} />
  </div>
{/if}
