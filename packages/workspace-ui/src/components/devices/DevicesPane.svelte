<script lang="ts">
  import { Monitor, Package, Plus, Settings2, X } from "@lucide/svelte";
  import type { DeviceAction, DeviceButton, DeviceInput, DevicePreview, DeviceSummary } from "@solus/contracts/device-types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import { toasts } from "../../lib/toasts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import { underStrip } from "../ui/lib/pane-strip";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import { settingsHost } from "../settings/lib/settings-host.svelte";
  import { Button } from "../ui/button";
  import * as TooltipUI from "../ui/tooltip";
  import DeviceBuilds from "./DeviceBuilds.svelte";
    import DevicePicker from "./DevicePicker.svelte";
  import DeviceStream from "./DeviceStream.svelte";
  import DeviceRunBuild from "./DeviceRunBuild.svelte";
  import DeviceRunLog from "./DeviceRunLog.svelte";
  import DeviceRunProfiles from "./DeviceRunProfiles.svelte";
  import DeviceToolbar from "./DeviceToolbar.svelte";
  import DeviceTools from "./DeviceTools.svelte";
  import { deviceLiveState, devicesPaneView, liveStateLabel, previewGroups, screenshotFileName, selectedPreview, type DeviceLiveState } from "./lib/device-pane";
  import { deviceViewState } from "./lib/device-view-state.svelte";
  import { pendingKey } from "./lib/device-tools";

  /**
   * The Devices pane: one session's simulators and emulators beside its
   * conversation (docs/plans/native-devices.md). The host owns which devices
   * the session has open; this pane shows one at a time with tabs, the live
   * screen, control, and Tools. Closing a tab never powers a device off.
   */

  let { params, paneId, surfaceVisible = true }: RouteSurfaceProps<"devices"> = $props();

  const session = getWorkspaceContext();
  const actions = paneActions(() => paneId);
  // Under the companion strip the pane draws no seam and no floating cluster.
  const isUnderStrip = underStrip();
  /** The PaneChrome controls shown: close, plus move and maximize when offered. */
  const chromeControls = $derived(1 + (actions.isLeading ? 0 : 1) + (actions.inPane ? 1 : 0));
  const sessionId = $derived.by(() => {
    if (params.sessionId) return params.sessionId;
    const tabId = session.focusedChatTabId ?? session.activeTabId;
    return tabId ? (session.sessionFor(tabId)?.id ?? null) : null;
  });
  // Devices belong to the host the session runs on.
  const serverId = $derived(params.serverId ?? (sessionId ? session.serverIdForSession(sessionId) : session.fallbackServerId));

  const deviceState = $derived(devicesStore.state(serverId));
  const showBuilds = $derived(deviceViewState.isShowingBuilds(serverId));
  const unavailable = $derived(devicesStore.unavailable.get(serverId));
  const previews = $derived(devicesStore.previewsFor(serverId, sessionId));
  // An extra Devices tab shows only the device chosen in it; until then, the picker.
  const preview = $derived.by(() => {
    if (!sessionId) return null;
    if (!params.surfaceId) return selectedPreview(previews, deviceViewState.selected(serverId, sessionId));
    const chosen = deviceViewState.selectedInSurface(params.surfaceId);
    return previews.find((candidate) => candidate.devicePreviewId === chosen) ?? null;
  });
  const device = $derived(preview ? devicesStore.device(serverId, preview) : undefined);
  const control = $derived(preview ? devicesStore.control(serverId, preview) : null);
  const holdsControl = $derived(preview ? devicesStore.holdsControl(serverId, preview) : false);
  const hostStatus = $derived(preview ? deviceState?.hostStatuses.find((entry) => entry.deviceHostId === preview.deviceHostId) : undefined);
  const liveState = $derived(deviceLiveState(device, preview ? devicesStore.isBooting(serverId, preview) : false, hostStatus));
  const othersUsing = $derived(preview && sessionId ? devicesStore.otherSessionsUsing(serverId, sessionId, preview) : 0);
  // The first touch takes control, also from another person. A working agent's
  // device needs an explicit Take control first.
  const canInteract = $derived(liveState === "live" && !!control && !(control.lease?.holder.kind === "agent" && !control.agentPaused));

  let adding = $state(false);
  const view = $derived(devicesPaneView({ isReady: !unavailable && !!deviceState?.settings.enabled, hasSession: !!sessionId, showBuilds, adding, hasPreview: !!preview }));
  let toolsOpen = $state(false);
  /** The build log shown under the toolbar, and whether the profile editor replaces the stage. */
  let runLogId = $state<string | null>(null);
  let editingProfiles = $state(false);
  // Build & run builds in the conversation's own checkout (its worktree, if it has one).
  const checkoutPath = $derived.by(() => {
    const run = sessionId ? session.sessions.byId[sessionId]?.run : undefined;
    return run ? (run.gitContext?.worktreePath ?? run.workingDirectory) || null : null;
  });
  let busy = $state(false);
  let opening = $state<string | null>(null);
  let pendingAction = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let stream = $state<{ focusKeyboard: () => void; resetPose: () => void; sendInputs: (inputs: DeviceInput[]) => Promise<void> } | null>(null);
  /** This client failed to draw 3D once; it shows the flat view until reload. */
  let phoneUnavailable = $state(false);

  $effect(() => {
    if (!deviceState && !unavailable) void devicesStore.load(serverId);
  });

  // Read settings while Tools is open and visible; nothing polls otherwise.
  $effect(() => {
    if (!toolsOpen || !surfaceVisible || !preview || liveState !== "live") return;
    const target = { deviceHostId: preview.deviceHostId, deviceId: preview.deviceId };
    const read = () => void devicesStore.loadDetail(serverId, target).catch(() => {});
    read();
    const timer = setInterval(read, 5_000);
    return () => clearInterval(timer);
  });

  function failed(action: string) {
    return (cause: unknown) => void toasts.error(action, { description: deviceErrorMessage(cause) });
  }

  // Setup is its own page: Settings → Devices, on the host of this pane.
  function openDeviceSettings() {
    settingsHost.serverId = serverId;
    session.showSettings("devices");
  }

  function rememberSelection(devicePreviewId: string) {
    if (params.surfaceId) deviceViewState.selectInSurface(params.surfaceId, devicePreviewId);
    else if (sessionId) deviceViewState.select(serverId, sessionId, devicePreviewId);
  }

  function refocusComposer() {
    session.router.focusPane(session.router.leadingPane.id);
    requestInputFocus();
  }

  async function run<T>(work: () => Promise<T>, label: string): Promise<T | undefined> {
    busy = true;
    try {
      return await work();
    } catch (error) {
      failed(label)(error);
      return undefined;
    } finally {
      busy = false;
    }
  }

  async function openDevice(candidate: DeviceSummary) {
    if (!sessionId) return;
    opening = `${candidate.deviceHostId}:${candidate.deviceId}`;
    const opened = await run(() => devicesStore.open(serverId, sessionId, candidate), "Couldn't open the device");
    opening = null;
    if (opened) {
      rememberSelection(opened.devicePreviewId);
      adding = false;
      refocusComposer();
    }
  }

  async function closePreview(target: DevicePreview) {
    if (!sessionId) return;
    await run(() => devicesStore.close(serverId, sessionId, target), "Couldn't close the device");
    refocusComposer();
  }

  async function shutdown() {
    if (!preview || !device) return;
    const others = othersUsing > 0 ? ` ${othersUsing} other session${othersUsing === 1 ? " is" : "s are"} using it.` : "";
    if (!confirm(`Power off ${device.name}?${others}`)) return;
    await run(() => devicesStore.shutdown(serverId, { ...preview, platform: device.platform }), "Couldn't power off the device");
  }

  async function takeControl() {
    if (!preview) return;
    await run(() => devicesStore.takeControl(serverId, preview, sessionId ?? undefined), "Couldn't take control");
  }

  function sendButton(button: DeviceButton) {
    if (!preview) return;
    void stream?.sendInputs([{ kind: "button", button }]).catch(failed("Couldn't press the button"));
  }

  function rotate() {
    if (!preview) return;
    void stream?.sendInputs([{ kind: "rotate" }]).catch(failed("Couldn't rotate the device"));
  }

  async function runAction(action: DeviceAction) {
    if (!preview) return;
    pendingAction = pendingKey(action);
    try {
      await devicesStore.action(serverId, preview, action);
    } catch (error) {
      failed("The device did not apply that setting")(error);
    } finally {
      pendingAction = null;
    }
  }

  async function screenshot() {
    if (!preview || !device) return;
    const shot = await run(() => devicesStore.screenshot(serverId, preview), "Couldn't take a screenshot");
    if (!shot) return;
    const name = screenshotFileName(device, shot.capturedAt);
    const signed = await serverConnections.apiFor(serverId).assetCreateUrl(undefined, { assetId: shot.assetId, name }).catch(failed("Couldn't download the screenshot"));
    if (!signed) return;
    const link = document.createElement("a");
    link.href = new URL(signed.relativeUrl, serverConnections.httpOriginFor(serverId)).toString();
    link.download = name;
    link.click();
  }

  function tabLabel(target: DevicePreview): string {
    const custom = sessionId ? deviceViewState.name(serverId, sessionId, target.devicePreviewId) : undefined;
    return custom ?? devicesStore.device(serverId, target)?.name ?? target.deviceId;
  }

  function tabStatus(target: DevicePreview): DeviceLiveState {
    const hostEntry = deviceState?.hostStatuses.find((entry) => entry.deviceHostId === target.deviceHostId);
    return deviceLiveState(devicesStore.device(serverId, target), devicesStore.isBooting(serverId, target), hostEntry);
  }

  function selectPreview(target: DevicePreview) {
    rememberSelection(target.devicePreviewId);
    deviceViewState.showBuilds(serverId, false);
    adding = false;
  }

  function commitRename(target: DevicePreview, value: string) {
    if (sessionId) deviceViewState.rename(serverId, sessionId, target.devicePreviewId, value);
    renaming = null;
  }
</script>

<!-- The header reserves the raised pane cluster: the 0.625rem right inset,
     one 1.625rem pill per control 0.375rem apart, and one more gap. -->
<div
  class="relative flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {actions.isLeading || isUnderStrip() ? '' : 'border-l border-(--solus-container-border)'} {isUnderStrip()
    ? ''
    : chromeControls === 3
    ? 'pointer-fine:[--solus-pane-chrome-inset:6.625rem]'
    : chromeControls === 2
      ? 'pointer-fine:[--solus-pane-chrome-inset:4.625rem]'
      : 'pointer-fine:[--solus-pane-chrome-inset:2.625rem]'}"
  onfocusin={() => session.router.focusPane(paneId)}
  data-testid="devices-pane"
>
  <!-- The same chrome row as the browser pane: device chips grouped under the
       device host that runs them, then the way to add another. -->
  <div class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1.5 pr-[max(0.625rem,var(--solus-pane-chrome-inset,6.25rem))] pl-[max(0.625rem,var(--solus-chrome-lead-inset,0px))] pointer-coarse:pr-[max(0.625rem,var(--solus-pane-chrome-inset,9.625rem))]">
    <div class="no-scrollbar no-drag flex min-w-0 flex-1 items-center gap-2 overflow-x-auto" role="tablist" aria-label="Devices in this session">
      {#each previewGroups(deviceState, previews) as group (group.deviceHostId)}
        {@const holdsActive = group.previews.some((target) => target.devicePreviewId === preview?.devicePreviewId)}
        <!-- The chips keep their look on the Builds page: the pressed Builds pill says which view is open. -->
        <div class="no-drag flex shrink-0 items-center gap-0.5 rounded-full py-0.5 pr-0.5 pl-2.5 {holdsActive ? 'bg-[var(--wash-1)] shadow-[shadow:0_0_0_0.5px_var(--hairline)]' : ''}">
          <Monitor class="size-3 shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
          <span class="text-workspace-chrome mr-1 ml-1.5 max-w-32 shrink-0 truncate text-(--solus-text-tertiary)" title={group.label}>{group.label}</span>
          {#each group.previews as target (target.devicePreviewId)}
            {@const chosen = target.devicePreviewId === preview?.devicePreviewId}
            {@const selected = chosen && !showBuilds && !adding}
            {@const status = tabStatus(target)}
            <div class="group/page flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-full py-1 pr-1 pl-2.5 transition-colors {chosen ? 'bg-[var(--card)] shadow-[shadow:0_0_0_0.5px_var(--hairline-strong)]' : 'hover:bg-[var(--wash-2)]'}">
              {#if status !== "live"}
                <span class="size-1.5 shrink-0 rounded-full {status === 'booting' ? 'bg-[var(--warning)]' : 'bg-[var(--failure)]'}" title={liveStateLabel(status)}></span>
              {/if}
              {#if renaming === target.devicePreviewId}
                <!-- svelte-ignore a11y_autofocus -->
                <input class="text-workspace-chrome w-32 bg-transparent font-medium text-(--solus-text-primary) outline-none" value={tabLabel(target)} autofocus aria-label="Device tab name"
                  onkeydown={(event) => { if (event.key === "Enter") commitRename(target, event.currentTarget.value); if (event.key === "Escape") { event.stopPropagation(); renaming = null; } }}
                  onblur={(event) => commitRename(target, event.currentTarget.value)} />
              {:else}
                <button type="button" role="tab" aria-selected={selected}
                  class="text-workspace-chrome min-w-0 max-w-40 truncate font-medium {chosen ? 'text-(--solus-text-primary)' : 'text-(--solus-text-secondary)'}"
                  onclick={() => selectPreview(target)}
                  ondblclick={() => (renaming = target.devicePreviewId)}
                  onkeydown={(event) => { if (event.key === "F2") renaming = target.devicePreviewId; }}
                  title="Double-click or press F2 to rename">
                  {tabLabel(target)}
                </button>
              {/if}
              <!-- The close holds its slot at zero opacity, so hovering a chip
                   never shifts the label under the pointer. -->
              <button type="button"
                class="flex size-4 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-opacity group-hover/page:opacity-100 hover:bg-[var(--wash-3)] hover:text-(--solus-text-primary) focus-visible:opacity-100 {chosen ? 'opacity-50' : 'opacity-0'}"
                aria-label="Close {tabLabel(target)}" onclick={() => closePreview(target)}>
                <X class="size-2.5" />
              </button>
            </div>
          {/each}
        </div>
      {/each}
    </div>
    <!-- The header controls of the other panes: soft raised pills, pressed
         when their view is open. -->
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps} type="button"
            class="{PAGE_SOFT_ICON_BTN} disabled:cursor-not-allowed disabled:opacity-50 {adding ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
            aria-label="Add a device" aria-expanded={adding} disabled={!sessionId || !deviceState?.settings.enabled}
            onclick={() => { adding = !adding; if (adding) deviceViewState.showBuilds(serverId, false); }}>
            <Plus size={15} strokeWidth={1.5} />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value="Add a device" />
    </TooltipUI.Root>
    <button type="button"
      class="{PAGE_SOFT_ICON_BTN} text-workspace-chrome w-auto! gap-1.5 px-2.5 pointer-coarse:w-auto! disabled:cursor-not-allowed disabled:opacity-50 {showBuilds ? 'bg-[var(--wash-3)]! text-foreground!' : ''}"
      aria-pressed={showBuilds} disabled={!deviceState?.settings.enabled}
      onclick={() => deviceViewState.showBuilds(serverId, !showBuilds)}>
      <Package size={15} strokeWidth={1.5} />Builds{#if deviceState?.builds.length}<span class="text-(--solus-text-tertiary) tabular-nums">{deviceState.builds.length}</span>{/if}
    </button>
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps} type="button" class={PAGE_SOFT_ICON_BTN} aria-label="Device setup" onclick={openDeviceSettings}>
            <Settings2 size={15} strokeWidth={1.5} />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value="Device setup" />
    </TooltipUI.Root>
  </div>

  {#if view === "status"}
    <div class="text-workspace-chrome flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center" role="status">
      <p class="text-(--solus-text-tertiary)">
        {#if unavailable}{unavailable}{:else if !deviceState}Loading devices…{:else if !deviceState.settings.enabled}Device support is off on this host.{:else}Open a conversation to show its devices.{/if}
      </p>
      {#if deviceState && !deviceState.settings.enabled && !unavailable}
        <Button size="sm" variant="outline" onclick={openDeviceSettings}>Open device settings</Button>
      {/if}
    </div>
  {:else if view === "builds" && deviceState}
    <div class="text-workspace-chrome flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-8">
      <div class="w-full max-w-md">
        <DeviceBuilds {serverId} {sessionId} {deviceState} onInstalled={refocusComposer} />
      </div>
    </div>
  {:else if view === "picker" && deviceState && sessionId}
    <DevicePicker {serverId} {deviceState} {sessionId} {opening} onOpen={openDevice}
      onCancel={preview ? () => { adding = false; refocusComposer(); } : undefined} />
  {:else if preview}
    {#if runLogId}
      <DeviceRunLog {serverId} runId={runLogId} visible={surfaceVisible} onClose={() => { runLogId = null; refocusComposer(); }} />
    {/if}
    {#if editingProfiles && checkoutPath}
      <div class="text-workspace-chrome flex min-h-0 flex-1 justify-center overflow-y-auto px-6 py-6">
        <div class="w-full max-w-lg">
          <DeviceRunProfiles {serverId} {checkoutPath} onDone={() => (editingProfiles = false)} />
        </div>
      </div>
    {:else}
    <!-- The stage: the device sits on the app background, with its
         controls in a pill beside it. -->
    <div class="text-workspace-chrome relative flex min-h-0 flex-1 overflow-hidden">
      {#if liveState === "stopped" && device}
        <div class="relative flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p class="text-(--solus-text-secondary)">{device.name} is not running.</p>
          <Button size="sm" disabled={busy} onclick={() => sessionId && void openDevice(device)}>Boot device</Button>
        </div>
      {:else if liveState === "offline"}
        <div class="relative flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p class="text-(--solus-text-secondary)">The device host is offline.</p>
          {#if hostStatus?.detail}<p class="text-(--solus-text-tertiary)">{hostStatus.detail}</p>{/if}
        </div>
      {:else}
        {#key `${preview.deviceHostId}:${preview.deviceId}`}
          <div class="relative flex min-h-0 flex-1 p-[1.625rem]">
            <DeviceStream bind:this={stream} {serverId} deviceHostId={preview.deviceHostId} deviceId={preview.deviceId} platform={preview.platform}
              deviceName={device?.name ?? ""} showPhone={deviceViewState.presentation === "phone" && !phoneUnavailable}
              onPhoneUnavailable={() => (phoneUnavailable = true)}
              active={surfaceVisible && liveState === "live"} {canInteract} onInputError={(message) => toasts.error("The device did not take that input", { description: message })} />
          </div>
        {/key}
      {/if}
      <div class="relative flex shrink-0 items-center py-3 pr-3">
        <DeviceToolbar
          platform={preview.platform}
          name={tabLabel(preview)}
          version={device?.version ?? ""}
          sharedNote={othersUsing > 0 ? `Also open in ${othersUsing} other session${othersUsing === 1 ? "" : "s"}` : ""}
          {liveState}
          {control}
          {holdsControl}
          {toolsOpen}
          {busy}
          onTakeControl={() => void takeControl()}
          onRelease={() => void devicesStore.releaseControl(serverId, preview).catch(failed("Couldn't release control"))}
          onResumeAgent={() => void devicesStore.resumeAgent(serverId, preview).catch(failed("Couldn't resume the agent"))}
          onButton={sendButton}
          onRotate={rotate}
          onScreenshot={() => void screenshot()}
          onKeyboard={() => stream?.focusKeyboard()}
          onToggleTools={() => (toolsOpen = !toolsOpen)}
          onShutdown={() => void shutdown()}
          presentation={deviceViewState.presentation}
          {phoneUnavailable}
          onPresentation={(presentation) => deviceViewState.setPresentation(presentation)}
          onResetView={() => stream?.resetPose()}
        >
          {#snippet runBuild()}
            {#if device}
              <DeviceRunBuild {serverId} {sessionId} {device} {checkoutPath}
                onShowLog={(runId) => { runLogId = runId; editingProfiles = false; }}
                onEditProfiles={() => (editingProfiles = true)} />
            {/if}
          {/snippet}
        </DeviceToolbar>
      </div>
    </div>
    {/if}
    {#if toolsOpen && device && liveState === "live"}
      <DeviceTools platform={device.platform} detail={devicesStore.detail(serverId, preview)} pending={pendingAction} run={(action) => void runAction(action)} />
    {/if}
  {/if}

  <PaneChrome
    onClose={actions.close}
    onToggleMaximize={actions.inPane ? actions.toggleMaximize : null}
    maximized={actions.maximized}
    closeLabel="Close devices"
    raised="soft"
  />
</div>
