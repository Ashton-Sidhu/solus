<script lang="ts">
  import { Hammer as BuildIcon, Undo2 as RollbackIcon } from "@lucide/svelte";
  import { activationLabel, shortCommit, type AppLiveState } from "@solus/client-core/app-versions";
  import { Button } from "../../ui/button";
  import ActivationConfirm from "./ActivationConfirm.svelte";
  import BuildLog from "./BuildLog.svelte";
  import type { VersionActions } from "./lib/version-actions.svelte";

  /**
   * What stands between the live version and the history, plain above it: a
   * build in progress, with its log, and a rollback, with the roll forward
   * back to the newer build. With neither, it draws nothing.
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
      <BuildIcon size={16} class="shrink-0 text-(--solus-status-running)" aria-hidden="true" />
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
    <BuildIcon size={16} class="shrink-0 text-(--solus-status-running)" aria-hidden="true" />
    The host starts a build of revision <span class="font-mono text-xs">{shortCommit(actions.deployingCommit)}</span>.
  </div>
{/if}

{#if state.live && state.rolledBackFrom}
  {@const later = state.rolledBackFrom}
  {@const liveNumber = state.live.number}
  <div class="flex min-w-0 flex-col gap-2 px-1" data-testid="app-version-rolled-back">
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <RollbackIcon size={16} class="shrink-0 text-(--warning)" aria-hidden="true" />
      <span class="min-w-48 flex-1 text-sm text-pretty">
        Rolled back from <span class="font-medium tabular-nums">v{later.number}</span> to v{liveNumber}. The newer build is kept and can run again.
      </span>
      <Button size="sm" variant="outline" class="shrink-0" disabled={actions.isActivating || isDeploying} onclick={() => actions.askToActivate("live:forward")}>
        {activationLabel(later.number, liveNumber)}
      </Button>
    </div>
    <ActivationConfirm {actions} rowKey="live:forward" target={later.number} live={liveNumber} />
  </div>
{/if}
