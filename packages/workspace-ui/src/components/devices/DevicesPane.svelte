<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
  import type { DeviceAction, DeviceButton, DevicePreview, DeviceSummary } from "@solus/contracts/device-types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import { settingsHost } from "../settings/lib/settings-host.svelte";
  import { Button } from "../ui/button";
  import DeviceBuilds from "./DeviceBuilds.svelte";
  import DeviceControlBar from "./DeviceControlBar.svelte";
  import DevicePicker from "./DevicePicker.svelte";
  import DeviceStream from "./DeviceStream.svelte";
  import DeviceTools from "./DeviceTools.svelte";
  import { deviceLiveState, liveStateLabel, screenshotFileName, selectedPreview } from "./lib/device-pane";
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
  const preview = $derived(sessionId ? selectedPreview(previews, deviceViewState.selected(serverId, sessionId)) : null);
  const device = $derived(preview ? devicesStore.device(serverId, preview) : undefined);
  const control = $derived(preview ? devicesStore.control(serverId, preview) : null);
  const holdsControl = $derived(preview ? devicesStore.grant(serverId, preview) !== null : false);
  const hostStatus = $derived(preview ? deviceState?.hostStatuses.find((entry) => entry.deviceHostId === preview.deviceHostId) : undefined);
  const liveState = $derived(deviceLiveState(device, preview ? devicesStore.isBooting(serverId, preview) : false, hostStatus));
  const othersUsing = $derived(preview && sessionId ? devicesStore.otherSessionsUsing(serverId, sessionId, preview) : 0);
  // Free devices take control on first touch; a device someone else controls
  // needs an explicit Take control first.
  const canInteract = $derived(liveState === "live" && !!control && (holdsControl || !control.lease));

  let adding = $state(false);
  let toolsOpen = $state(false);
  let busy = $state(false);
  let opening = $state<string | null>(null);
  let pendingAction = $state<string | null>(null);
  let renaming = $state<string | null>(null);
  let stream = $state<{ focusKeyboard: () => void } | null>(null);

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
      deviceViewState.select(serverId, sessionId, opened.devicePreviewId);
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
    const result = await run(() => devicesStore.takeControl(serverId, preview, sessionId ?? undefined), "Couldn't take control");
    if (result?.status === "superseded") toasts.info("Someone else took control first.");
  }

  function sendButton(button: DeviceButton) {
    if (!preview) return;
    void devicesStore.input(serverId, preview, 0, [{ kind: "button", button }]).catch(failed("Couldn't press the button"));
  }

  function rotate() {
    if (!preview) return;
    void devicesStore.input(serverId, preview, 0, [{ kind: "rotate" }]).catch(failed("Couldn't rotate the device"));
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

  function commitRename(target: DevicePreview, value: string) {
    if (sessionId) deviceViewState.rename(serverId, sessionId, target.devicePreviewId, value);
    renaming = null;
  }
</script>

<div
  class="relative flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {actions.isLeading ? '' : 'border-l border-(--solus-container-border)'}"
  onfocusin={() => session.router.focusPane(paneId)}
  data-testid="devices-pane"
>
  <div class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1.5 pr-[max(0.625rem,var(--solus-pane-chrome-inset,6.25rem))] pl-[max(0.625rem,var(--solus-chrome-lead-inset,0px))] pointer-coarse:pr-[max(0.625rem,var(--solus-pane-chrome-inset,9.625rem))]">
    <div class="no-scrollbar no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Devices in this session">
      {#each previews as target (target.devicePreviewId)}
        {@const selected = target.devicePreviewId === preview?.devicePreviewId}
        <div class="flex min-w-0 max-w-48 shrink-0 items-center overflow-hidden rounded-md {selected ? 'bg-muted' : ''}">
          {#if renaming === target.devicePreviewId}
            <!-- svelte-ignore a11y_autofocus -->
            <input class="w-32 bg-transparent px-2 py-1 text-workspace-chrome outline-none" value={tabLabel(target)} autofocus aria-label="Device tab name"
              onkeydown={(event) => { if (event.key === "Enter") commitRename(target, event.currentTarget.value); if (event.key === "Escape") renaming = null; }}
              onblur={(event) => commitRename(target, event.currentTarget.value)} />
          {:else}
            <button type="button" role="tab" aria-selected={selected}
              class="min-w-0 truncate px-2 py-1 text-workspace-chrome {selected ? '' : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => sessionId && deviceViewState.select(serverId, sessionId, target.devicePreviewId)}
              ondblclick={() => (renaming = target.devicePreviewId)}
              onkeydown={(event) => { if (event.key === "F2") renaming = target.devicePreviewId; }}
              title="Double-click or press F2 to rename">
              {tabLabel(target)}
            </button>
          {/if}
          <button type="button" class="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close {tabLabel(target)}" onclick={() => closePreview(target)}>
            <X class="size-3.5" />
          </button>
        </div>
      {/each}
      <Button size="icon-xs" variant="ghost" aria-label="Add a device" aria-expanded={adding} disabled={!sessionId || !deviceState?.settings.enabled}
        onclick={() => (adding = !adding)}>
        <Plus />
      </Button>
    </div>
    <Button size="xs" variant={showBuilds ? "secondary" : "ghost"} class="no-drag shrink-0" disabled={!deviceState?.settings.enabled}
      onclick={() => deviceViewState.showBuilds(serverId, !showBuilds)}>
      Builds{deviceState?.builds.length ? ` ${deviceState.builds.length}` : ""}
    </Button>
    <Button size="xs" variant="ghost" class="no-drag shrink-0" onclick={openDeviceSettings}>Setup</Button>
  </div>

  {#if unavailable}
    <p class="p-4 text-workspace-chrome text-muted-foreground" role="status">{unavailable}</p>
  {:else if !deviceState}
    <p class="p-4 text-workspace-chrome text-muted-foreground" role="status">Loading devices…</p>
  {:else if !deviceState.settings.enabled}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4">
      <p class="text-workspace-chrome text-muted-foreground">Device support is off on this host.</p>
      <Button size="sm" variant="outline" onclick={openDeviceSettings}>Open device settings</Button>
    </div>
  {:else if showBuilds}
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <DeviceBuilds {serverId} {sessionId} {deviceState} onInstalled={refocusComposer} />
    </div>
  {:else if !sessionId}
    <p class="p-4 text-workspace-chrome text-muted-foreground">Open a conversation to show its devices.</p>
  {:else if adding || !preview}
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <DevicePicker {serverId} {deviceState} {sessionId} {opening} onOpen={openDevice} />
    </div>
  {:else}
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 px-3 py-1.5 text-chrome-dense text-muted-foreground">
        <span class="min-w-0 truncate">{device?.version ?? ""} · {deviceState.hosts.find((host) => host.deviceHostId === preview.deviceHostId)?.label ?? preview.deviceHostId}</span>
        <span class="shrink-0">{liveStateLabel(liveState)}</span>
        {#if othersUsing > 0}<span class="shrink-0">· also in {othersUsing} other session{othersUsing === 1 ? "" : "s"}</span>{/if}
      </div>
      {#if liveState === "stopped" && device}
        <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4">
          <p class="text-workspace-chrome text-muted-foreground">{device.name} is not running.</p>
          <Button size="sm" variant="outline" disabled={busy} onclick={() => sessionId && void openDevice(device)}>Boot device</Button>
        </div>
      {:else if liveState === "offline"}
        <p class="flex-1 p-4 text-workspace-chrome text-muted-foreground">{hostStatus?.detail ?? "The device host is offline."}</p>
      {:else}
        {#key `${preview.deviceHostId}:${preview.deviceId}`}
          <div class="flex min-h-0 flex-1 p-3">
            <DeviceStream bind:this={stream} {serverId} deviceHostId={preview.deviceHostId} deviceId={preview.deviceId} platform={preview.platform}
              active={surfaceVisible && liveState === "live"} {canInteract} onInputError={(message) => toasts.error("The device did not take that input", { description: message })} />
          </div>
        {/key}
      {/if}
      {#if toolsOpen && device}
        <DeviceTools platform={device.platform} detail={devicesStore.detail(serverId, preview)} pending={pendingAction} run={(action) => void runAction(action)} />
      {/if}
      {#if control && device}
        <DeviceControlBar
          platform={device.platform}
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
        />
      {/if}
    </div>
  {/if}

  <PaneChrome
    onClose={actions.close}
    onOpenInSplit={!actions.isLeading ? actions.moveAcross : undefined}
    isLeading={actions.isLeading}
    onToggleMaximize={actions.inPane ? actions.toggleMaximize : null}
    maximized={actions.maximized}
    closeLabel="Close devices"
  />
</div>
