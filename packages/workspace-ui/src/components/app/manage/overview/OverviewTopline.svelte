<script lang="ts">
  import { ArrowUpRight as OpenIcon, Pin as PinIcon } from "@lucide/svelte";
  import type { AppRuntimeView, AppSummary } from "@solus/contracts/apps";
  import { PAGE_SOFT_ICON_BTN } from "../../../../lib/page-chrome";
  import * as TooltipUI from "../../../ui/tooltip";
  import { Button } from "../../../ui/button";
  import { appRunState, appRunStateLabel, appStateText, appVersionHostLine } from "../lib/overview";

  /**
   * The first line of the Overview: whether the app runs, its version, and its
   * host, then the commands a reader takes from here: pin it, stop or start it,
   * and open it. The line under it says what the runner does now.
   */
  interface Props {
    app: AppSummary;
    hostLabel: string;
    /** The version the host builds now; null when it builds none. */
    building: { number: number } | null;
    /** Null until the host answers with the app's state. */
    runtime: AppRuntimeView | null;
    busy: boolean;
    pinned: boolean;
    onToggleStopped: () => void;
    onTogglePinned: () => void;
    /** Absent for an app with no UI: there is nothing to open. */
    onOpenApp?: () => void;
  }
  let { app, hostLabel, building, runtime, busy, pinned, onToggleStopped, onTogglePinned, onOpenApp }: Props = $props();

  const runState = $derived(appRunState(app));
</script>

<header class="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="app-overview-header">
  <div class="flex min-w-48 flex-1 flex-col gap-1">
    <p class="m-0 text-sm tabular-nums text-(--solus-text-secondary)" data-testid="app-overview-state">
      <span class="font-medium {runState === 'running' ? 'text-(--success)' : 'text-foreground'}">{appRunStateLabel(runState)}</span>
      · {appVersionHostLine(app, hostLabel)}
    </p>
    <p class="m-0 text-[13px] text-(--solus-text-tertiary)">{appStateText(app, building, runtime)}</p>
  </div>
  <div class="flex shrink-0 items-center gap-1.5">
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class={PAGE_SOFT_ICON_BTN}
            aria-label={pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            aria-pressed={pinned}
            onclick={onTogglePinned}
            data-testid="app-overview-pin"
          >
            <PinIcon size={15} strokeWidth={1.5} fill={pinned ? "currentColor" : "none"} aria-hidden="true" />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={pinned ? "Unpin from sidebar" : "Pin to sidebar"} />
    </TooltipUI.Root>
    {#if app.activeVersion !== null}
      <Button size="sm" variant="ghost" class="text-workspace-chrome" disabled={busy} onclick={onToggleStopped} data-testid="app-overview-toggle-stopped">
        {app.stopped ? "Start" : "Stop"}
      </Button>
    {/if}
    {#if onOpenApp}
      <Button size="sm" class="rounded-full px-3.5 text-workspace-chrome" onclick={onOpenApp} data-testid="app-overview-open">
        Open app <OpenIcon />
      </Button>
    {/if}
  </div>
</header>
