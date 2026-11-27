<script lang="ts">
  import { Activity as InFlightIcon, ArrowUpRight as OpenIcon, Cpu as MemoryIcon, GitBranch as VersionIcon, Monitor as HostIcon, Pin as PinIcon } from "@lucide/svelte";
  import type { AppRuntimeView, AppSummary } from "@solus/contracts/apps";
  import { PAGE_SOFT_ICON_BTN } from "../../../../lib/page-chrome";
  import * as TooltipUI from "../../../ui/tooltip";
  import { Button } from "../../../ui/button";
  import { appMemoryText, appStateTitle, appVersionText } from "../lib/overview";
  import { appState } from "../lib/states";
  import StateIcon from "../StateIcon.svelte";

  /**
   * The first line of the Overview: the app's state mark, its version, its
   * host, its memory, and the calls in progress, then the commands a reader
   * takes from here: pin it, stop or start it, and open it. The state is a
   * session mark, never a word: the words are its tooltip and its name.
   */
  interface Props {
    app: AppSummary;
    hostLabel: string;
    /** The version the host builds now; null when it builds none. */
    building: { number: number } | null;
    /** Null until the host answers with the app's state. */
    runtime: AppRuntimeView | null;
    /** The host does not answer now, so nothing it last said is current. */
    isHostUnreachable: boolean;
    busy: boolean;
    pinned: boolean;
    onToggleStopped: () => void;
    onTogglePinned: () => void;
    /** Absent for an app with no UI: there is nothing to open. */
    onOpenApp?: () => void;
  }
  let { app, hostLabel, building, runtime, isHostUnreachable, busy, pinned, onToggleStopped, onTogglePinned, onOpenApp }: Props = $props();

  const memory = $derived(appMemoryText(runtime));
  const inFlight = $derived(runtime?.running ? runtime.inFlight : 0);
</script>

<header class="flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="app-overview-header">
  <div class="flex min-w-48 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-[13px] leading-[18px] tabular-nums text-(--solus-text-tertiary)" data-testid="app-overview-state">
    <StateIcon state={appState(app, runtime, isHostUnreachable)} label={appStateTitle(app, building, runtime, isHostUnreachable)} />
    <span class="flex shrink-0 items-center gap-1.25"><VersionIcon size={14} strokeWidth={1.75} aria-hidden="true" />{appVersionText(app, building)}</span>
    <span class="flex min-w-0 items-center gap-1.25"><HostIcon size={14} strokeWidth={1.75} class="shrink-0" aria-hidden="true" /><span class="truncate">{hostLabel}</span></span>
    {#if memory}
      <span class="flex shrink-0 items-center gap-1.25" title="Memory"><MemoryIcon size={14} strokeWidth={1.75} aria-hidden="true" />{memory}</span>
    {/if}
    {#if inFlight > 0}
      <span class="flex shrink-0 items-center gap-1.25"><InFlightIcon size={14} strokeWidth={1.75} aria-hidden="true" />{inFlight} in progress</span>
    {/if}
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
