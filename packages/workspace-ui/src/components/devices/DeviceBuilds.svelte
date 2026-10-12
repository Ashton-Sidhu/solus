<script lang="ts">
  import { Download, Ellipsis, FolderOpen, Smartphone, Trash2, TriangleAlert } from "@lucide/svelte";
  import { type DeviceBuild, type DeviceState, type DeviceSummary } from "@solus/contracts/device-types";
  import { buildCardSummary, buildDetails, buildDownloadName, buildRunBlocker, deviceBuildTargets, isBuildOutput, shownNewBuild } from "@solus/client-core/device-builds";
  import { isChat } from "@solus/contracts/chat";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { projectsStore } from "../../contexts/projects/projects.store.svelte";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import { toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { RowCard } from "../ui/row-card";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import DeviceNewBuild from "./DeviceNewBuild.svelte";
  import DeviceRunLog from "./DeviceRunLog.svelte";
  import DeviceRunProfiles from "./DeviceRunProfiles.svelte";
  import { runDeviceBuild } from "./lib/run-build";
  import { conversationCheckout } from "./lib/device-pane";

  /**
   * App builds on this host (plan 016, S02), one row each in a Settings-style
   * card: the build's name and what it runs on. Run puts it on the best device
   * that fits; the … menu shows the rest of what it is, runs it on another
   * device, downloads an APK, or deletes the build's output from the host. A build whose output is gone is never
   * listed: the host leaves it out.
   */

  interface Props {
    serverId: string;
    sessionId: string | null;
    deviceState: DeviceState;
    onInstalled: () => void;
  }

  let { serverId, sessionId, deviceState, onInstalled }: Props = $props();
  const session = getWorkspaceContext();

  /** The build going onto a device, and which device, while it opens and installs. */
  let installing = $state<{ buildId: string; deviceName: string } | null>(null);
  let deletingBuildId = $state<string | null>(null);
  /** The host folder browser, open to choose a build output to add. */
  let browsing = $state(false);
  let importing = $state(false);
  /** Discovery runs again after the user fixes a phone that cannot take builds. */
  let rechecking = $state(false);
  /** The phone asked to pair, while it waits for the user to accept on it. */
  let pairingDeviceId = $state<string | null>(null);
  const now = Date.now();
  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? "This computer");
  const isBusy = $derived(installing !== null || deletingBuildId !== null);

  // A phone may have been plugged in, or an output deleted, since the last discovery.
  $effect(() => {
    void devicesStore.refresh(serverId).catch(() => {});
  });

  async function recheckDevices() {
    rechecking = true;
    try {
      await devicesStore.refresh(serverId);
    } catch (cause) {
      toasts.error("Couldn't check devices", { description: deviceErrorMessage(cause) });
    } finally {
      rechecking = false;
    }
  }

  async function pair(device: DeviceSummary) {
    pairingDeviceId = device.deviceId;
    try {
      await devicesStore.pair(serverId, device);
    } catch (cause) {
      toasts.error(`Couldn't pair with ${device.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      pairingDeviceId = null;
    }
  }

  function details(build: DeviceBuild) {
    const source = build.sessionId ? session.sessions.byId[build.sessionId] : undefined;
    return buildDetails(build, now, { projectPath: source?.run.workingDirectory, conversationTitle: source?.title });
  }

  async function install(build: DeviceBuild, device: DeviceSummary) {
    installing = { buildId: build.buildId, deviceName: device.name };
    try {
      const shown = await runDeviceBuild(session, serverId, sessionId, build, device);
      if (shown.physical) toasts.success(`${build.name} is open on ${shown.name}`);
      onInstalled();
    } catch (cause) {
      toasts.error(`${build.name} did not run on ${device.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      installing = null;
    }
  }

  async function download(build: DeviceBuild) {
    try {
      const link = document.createElement("a");
      link.href = await devicesStore.buildDownloadUrl(serverId, build);
      link.download = buildDownloadName(build);
      link.click();
    } catch (cause) {
      toasts.error("Couldn't download the build", { description: deviceErrorMessage(cause) });
    }
  }

  async function remove(build: DeviceBuild) {
    const what = build.assetId ? "the copy of this APK that Solus keeps" : "this .app bundle";
    if (!confirm(`Delete ${build.name}? This deletes ${what} from ${hostLabel}.`)) return;
    deletingBuildId = build.buildId;
    try {
      await devicesStore.deleteBuild(serverId, build);
      toasts.success(`Deleted ${build.name}`);
    } catch (cause) {
      toasts.error(`Couldn't delete ${build.name}`, { description: deviceErrorMessage(cause) });
    } finally {
      deletingBuildId = null;
    }
  }

  /** Add the chosen output. The browser stays open on an error, so another can be chosen. */
  async function importBuild(path: string) {
    if (importing) return;
    importing = true;
    try {
      await devicesStore.importBuild(serverId, path, sessionId);
      browsing = false;
    } catch (cause) {
      toasts.error("Couldn't add the build", { description: deviceErrorMessage(cause) });
    } finally {
      importing = false;
    }
  }

  // Browsing starts in the conversation's folder, where its builds are.
  const browseFrom = $derived.by(() => {
    const folder = sessionId ? session.sessions.byId[sessionId]?.run.workingDirectory : undefined;
    return folder && folder !== "~" ? folder : undefined;
  });

  // New build runs in the conversation's own checkout (its worktree, if it has one), as Build & run does,
  // or in the project the person chose: Builds also opens without a conversation.
  const sessionCheckout = $derived(conversationCheckout(sessionId ? session.sessions.byId[sessionId]?.run : undefined));
  let chosenCheckout = $state<string | null>(null);
  const checkoutPath = $derived(chosenCheckout ?? sessionCheckout);
  /** The host's projects, for choosing what New build builds. */
  const projects = $derived(projectsStore.projectsFor(serverId).filter((project) => !isChat(project.path)));
  $effect(() => {
    void projectsStore.loadProjectsFor(serverId, serverConnections.apiFor(serverId));
  });
  let editingProfiles = $state(false);
  let newBuildOpen = $state(false);
  /** The New build shown above the list while it runs, or after it failed until dismissed. */
  let dismissedRunId = $state<string | null>(null);
  const newBuild = $derived.by(() => {
    const run = shownNewBuild(devicesStore.runs(serverId), checkoutPath);
    return run && run.runId !== dismissedRunId ? run : null;
  });
</script>

<div class="flex flex-col gap-4" data-testid="device-builds">
  <div class="flex items-center gap-2">
    <h2 class="min-w-0 flex-1 truncate font-medium text-(--solus-text-primary)">Builds</h2>
    <button type="button" class="{PAGE_SECONDARY_BTN} disabled:cursor-not-allowed disabled:opacity-50" disabled={importing} title="Add a build that is already on {hostLabel}" onclick={() => (browsing = true)}>
      <FolderOpen size={14} />{importing ? "Adding…" : "Add existing…"}
    </button>
    <DeviceNewBuild {serverId} {sessionId} {checkoutPath} {projects} bind:open={newBuildOpen} onChooseProject={(path) => { chosenCheckout = path; editingProfiles = false; }} onEditProfiles={() => (editingProfiles = true)} />
  </div>
  {#if editingProfiles && checkoutPath}
    <!-- Saved: the next step is to build one, so New build opens on the saved profiles. -->
    <DeviceRunProfiles {serverId} {checkoutPath} onDone={() => (editingProfiles = false)} onSaved={() => { editingProfiles = false; newBuildOpen = true; }} />
  {:else}
  {#if newBuild}
    <!-- The build while it runs, or after it failed: its stage, step, issues and log in one card. -->
    <DeviceRunLog {serverId} runId={newBuild.runId} visible class="rounded-xl border border-border/50" onClose={() => (dismissedRunId = newBuild.runId)} />
  {/if}
  {#if deviceState.builds.length > 0}
    <!-- One card of rows, as Settings draws it. A row says what the build is
         and how old it is; the rest is in its … menu. -->
    <RowCard>
      {#each deviceState.builds as build (build.buildId)}
        {@const targets = deviceBuildTargets(deviceState, build, { canBoot: !!sessionId })}
        {@const isInstalling = installing?.buildId === build.buildId}
        <div class="flex min-w-0 items-center gap-2 py-2.5 pr-2.5 pl-4">
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="truncate font-medium text-(--solus-text-primary)">{build.name}</span>
            <span class="truncate text-chrome-dense text-(--solus-text-tertiary)">{buildCardSummary(build, now)}</span>
            {#if !targets[0]}
              <!-- Shown, not a tooltip: a disabled button shows no tooltip. -->
              <span class="text-chrome-dense text-(--solus-text-secondary)">{buildRunBlocker(deviceState, build, { canBoot: !!sessionId })}</span>
            {/if}
          </div>
          {#if targets[0]}
            {@const best = targets[0]}
            <Button size="xs" variant="outline" disabled={isBusy} title={isInstalling ? `Installing on ${installing?.deviceName}` : `Run on ${best.name}`}
              aria-label={isInstalling ? `Installing ${build.name} on ${installing?.deviceName}` : `Run ${build.name} on ${best.name}`}
              onclick={() => void install(build, best)}>
              {isInstalling ? "Installing…" : "Run"}
            </Button>
          {:else}
            <Button size="xs" variant="outline" disabled>Run</Button>
          {/if}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} size="icon-xs" variant="ghost" aria-label="More for {build.name}" disabled={isBusy}>
                  <Ellipsis />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="end" class="w-[min(17rem,calc(100vw-2rem))]">
              <!-- What the build is, as label and value rows. Long values wrap
                   instead of being cut off; the row already shows the name, kind and age. -->
              <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 pt-1.5 pb-2 text-xs leading-snug">
                {#each details(build) as row (row.label)}
                  <dt class="text-(--solus-text-tertiary)">{row.label}</dt>
                  <dd class="text-(--solus-text-primary) [overflow-wrap:anywhere]">{row.value}</dd>
                {/each}
              </dl>
              <DropdownMenu.Separator />
              {#if targets.length > 1}
                <DropdownMenu.Sub>
                  <DropdownMenu.SubTrigger>
                    <Smartphone class="size-4" />Run on another device
                  </DropdownMenu.SubTrigger>
                  <DropdownMenu.SubContent class="w-[min(16rem,calc(100vw-2rem))]">
                    {#each targets as device (`${device.deviceHostId}:${device.deviceId}`)}
                      <DropdownMenu.Item onSelect={() => void install(build, device)}>
                        <span class="min-w-0 flex-1 truncate">{device.name}</span>
                        <span class="text-muted-foreground">{device.physical ? "connected" : device.booted ? "running" : "starts it"}</span>
                      </DropdownMenu.Item>
                    {/each}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Sub>
              {/if}
              {#if build.assetId}
                <DropdownMenu.Item onSelect={() => void download(build)}>
                  <Download class="size-4" />Download APK
                </DropdownMenu.Item>
              {/if}
              {#if targets.length > 1 || build.assetId}<DropdownMenu.Separator />{/if}
              <DropdownMenu.Item variant="destructive" onSelect={() => void remove(build)}>
                <Trash2 class="size-4" />Delete…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {/each}
    </RowCard>
  {:else}
    <p class="text-(--solus-text-tertiary)">No builds yet. Make one with New build, or ask the agent.</p>
  {/if}
  {#if installing}<span class="sr-only" role="status" aria-live="polite">Installing on {installing.deviceName}</span>{/if}
  {#each deviceState.devices.filter((device) => device.physical && device.unavailableReason) as device (`${device.deviceHostId}:${device.deviceId}`)}
    <div role="status" class="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 py-2 pr-2 pl-3 text-(--solus-text-primary)">
      <TriangleAlert class="size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden="true" />
      <span class="min-w-0 flex-1">{pairingDeviceId === device.deviceId ? `Unlock ${device.name} and tap Trust.` : device.unavailableReason}</span>
      {#if device.needsPairing}
        <Button size="xs" class="shrink-0" disabled={pairingDeviceId !== null} onclick={() => void pair(device)}>{pairingDeviceId === device.deviceId ? "Waiting…" : "Pair"}</Button>
      {:else}
        <Button size="xs" variant="outline" class="shrink-0" disabled={rechecking} onclick={() => void recheckDevices()}>{rechecking ? "Checking…" : "Check again"}</Button>
      {/if}
    </div>
  {/each}
  {/if}
</div>

<!-- The host's folder browser: an .app bundle or an .apk is chosen, not opened. -->
<DirectoryPicker
  open={browsing}
  onClose={() => (browsing = false)}
  onSelect={(path) => void importBuild(path)}
  initialPath={browseFrom}
  title="Add an existing build"
  actionLabel={importing ? "Adding…" : "Add"}
  api={serverConnections.apiFor(serverId)}
  {serverId}
  hostLabel={serverId === serversStore.activeServer?.id ? undefined : hostLabel}
  chooses={isBuildOutput}
/>
