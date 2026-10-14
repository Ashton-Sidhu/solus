<script lang="ts">
  import { ChevronDown, Download, LoaderCircle } from "@lucide/svelte";
  import { DEVICE_RUN_TARGETS, isDeviceRunActive, type DeviceRunStartRequest, type DeviceRunTarget, type DeviceState, type DeviceSummary } from "@solus/contracts/device-types";
  import { buildRunsOn } from "@solus/client-core/device-builds";
  import { isChat } from "@solus/contracts/chat";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { projectsStore } from "../../contexts/projects/projects.store.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Tabs from "../ui/tabs";
  import DeviceRunLog from "./DeviceRunLog.svelte";
  import { runDeviceBuild } from "./lib/run-build";
  import { deviceViewState } from "./lib/device-view-state.svelte";

  interface Props { serverId: string; sessionId: string | null; deviceState: DeviceState; onInstalled: () => void }
  let { serverId, sessionId, deviceState, onInstalled }: Props = $props();
  const workspace = getWorkspaceContext();
  const pickerId = $props.id();
  const TARGET_LABELS: { [target in DeviceRunTarget]: string } = { "ios-simulator": "iOS Simulator", "ios-device": "iPhone or iPad", android: "Android" };
  const conversation = $derived(sessionId ? workspace.sessions.byId[sessionId]?.run : undefined);
  const selection = $derived(deviceViewState.runAppSelection(serverId, sessionId));
  const projectPath = $derived(selection.projectPath ?? (conversation && conversation.workingDirectory !== '~' && !isChat(conversation.workingDirectory) ? conversation.workingDirectory : null));
  const branchKey = $derived(`${serverId}\u0000${projectPath}`);
  const branchState = $derived(devicesStore.branches.get(branchKey));
  const branchError = $derived(devicesStore.branchErrors.get(branchKey));
  const selectedBranch = $derived(selection.branch || branchState?.defaultBranch || '');
  const isDev = $derived(selection.mode === 'dev');
  /** True until the host accepts the request. */
  let starting = $state(false);
  let installing = $state(false);
  let pairing = $state(false);
  let error = $state<string | null>(null);
  const projects = $derived(projectsStore.projectsFor(serverId).filter((project) => !isChat(project.path)));
  const localDevices = $derived(deviceState.devices.filter((device) => device.deviceHostId === 'local'));
  // A dev server reaches only simulators and emulators on this host.
  const simulators = $derived(localDevices.filter((device) => !device.physical));
  const simulator = $derived(simulators.find((candidate) => candidate.deviceId === selection.simulatorId));
  const latest = $derived(devicesStore.runs(serverId).find((run) => run.checkoutPath === projectPath && run.mode === selection.mode && (isDev || (run.branch === selectedBranch && run.target === selection.target))));
  const active = $derived(!!latest && isDeviceRunActive(latest));
  const devServerRunning = $derived(isDev && latest?.stage === 'running');
  const output = $derived(isDev ? undefined : deviceState.builds.find((build) => build.buildId === latest?.buildId));
  const installTargets = $derived(output ? localDevices.filter((device) => buildRunsOn(output, device)) : []);
  const installDevice = $derived(installTargets.find((candidate) => candidate.deviceId === selection.installDeviceId));

  $effect(() => {
    void projectsStore.loadProjectsFor(serverId, serverConnections.apiFor(serverId));
    void devicesStore.refresh(serverId).catch(() => {});
  });

  $effect(() => {
    if (projectPath) void devicesStore.loadBranches(serverId, projectPath);
  });

  const hasBranch = $derived(!!branchState?.branches.includes(selectedBranch));
  // A running dev server takes one more simulator; anything else waits for the run.
  const cannotOpen = $derived(!projectPath || !simulator || starting || (active && !devServerRunning));
  const cannotBuild = $derived(!projectPath || !hasBranch || active || starting);

  async function start(request: DeviceRunStartRequest) {
    starting = true;
    error = null;
    try {
      if (sessionId) request.sessionId = sessionId;
      await devicesStore.startRun(serverId, request, (question) => confirm(question));
      onInstalled();
    } catch (cause) { error = deviceErrorMessage(cause); }
    finally { starting = false; }
  }

  // The dev server uses the project as it is on disk; a production build uses the chosen branch.
  function openOnSimulator() {
    if (!projectPath || !simulator || cannotOpen) return;
    void start({ checkoutPath: projectPath, deviceHostId: simulator.deviceHostId, deviceId: simulator.deviceId, mode: 'dev', source: 'conversation' });
  }

  function build() {
    if (!projectPath || cannotBuild) return;
    void start({ checkoutPath: projectPath, mode: 'device', target: selection.target, source: 'main', branch: selectedBranch });
  }

  async function install() {
    if (!output || !installDevice || installing) return;
    installing = true;
    error = null;
    try { await runDeviceBuild(workspace, serverId, sessionId, output, installDevice); onInstalled(); }
    catch (cause) { error = deviceErrorMessage(cause); }
    finally { installing = false; }
  }

  async function pair(device: DeviceSummary) {
    if (pairing) return;
    pairing = true;
    try { await devicesStore.pair(serverId, device); }
    catch (cause) { error = deviceErrorMessage(cause); }
    finally { pairing = false; }
  }

  async function download() {
    if (!output?.assetId) return;
    try {
      const link = document.createElement("a");
      link.href = await devicesStore.buildDownloadUrl(serverId, output);
      link.download = output.name;
      link.click();
    } catch (cause) { error = deviceErrorMessage(cause); }
  }
</script>

{#snippet devicePicker(id: string, label: string, choices: DeviceSummary[], chosen: DeviceSummary | undefined, empty: string, onChoose: (deviceId: string) => void)}
  <div class="flex min-w-0 flex-col gap-1.5">
    <span id="{id}-label" class="text-chrome-dense text-(--solus-text-secondary)">{label}</span>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{id}-label {id}-value" disabled={starting || installing}>
            <span id="{id}-value" class="min-w-0 truncate">{chosen ? `${chosen.name} · ${chosen.platform === 'ios' ? 'iOS' : 'Android'}` : choices.length ? 'Choose a device' : empty}</span>
            <ChevronDown class="size-4 text-(--solus-text-secondary)" />
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content class="max-h-[min(20rem,var(--bits-dropdown-menu-content-available-height))]">
        <DropdownMenu.RadioGroup value={chosen?.deviceId ?? ''} onValueChange={onChoose}>
          {#each choices as target (target.deviceId)}<DropdownMenu.RadioItem value={target.deviceId}><span class="truncate">{target.name} · {target.platform === 'ios' ? 'iOS' : 'Android'}</span></DropdownMenu.RadioItem>{/each}
        </DropdownMenu.RadioGroup>
        {#if !choices.length}<DropdownMenu.Item disabled>{empty}</DropdownMenu.Item>{/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if chosen?.unavailableReason}
      <div class="flex items-center gap-3 rounded-lg border border-border px-3 py-2" role="status">
        <p class="text-chrome-dense min-w-0 flex-1 text-(--solus-text-secondary)">{pairing ? `Unlock ${chosen.name} and tap Trust.` : chosen.unavailableReason}</p>
        {#if chosen.needsPairing}<Button size="sm" variant="outline" disabled={pairing} onclick={() => void pair(chosen)}>{pairing ? 'Waiting for Trust…' : 'Pair device'}</Button>
        {:else}<Button size="sm" variant="outline" onclick={() => void devicesStore.refresh(serverId).catch((cause) => { error = deviceErrorMessage(cause); })}>Check again</Button>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="@container flex flex-col gap-6 text-workspace-chrome" data-testid="device-run-app">
  <h2 class="font-medium text-(--solus-text-primary)">Run app</h2>

  <Tabs.Root bind:value={selection.mode}>
    <Tabs.List class="w-full">
      <Tabs.Trigger value="dev">Dev server</Tabs.Trigger>
      <Tabs.Trigger value="device">Production build</Tabs.Trigger>
    </Tabs.List>
  </Tabs.Root>

  <div class="flex flex-col gap-3">
    <div class="flex min-w-0 flex-col gap-1.5">
      <span id="{pickerId}-project" class="text-chrome-dense text-(--solus-text-secondary)">Project</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-project {pickerId}-project-value" disabled={active || starting}>
              <span id="{pickerId}-project-value" class="min-w-0 truncate">{projects.find((project) => project.path === projectPath)?.folderName ?? projectPath ?? 'Choose a project'}</span>
              <ChevronDown class="size-4 text-(--solus-text-secondary)" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content class="max-h-[min(20rem,var(--bits-dropdown-menu-content-available-height))]">
          <DropdownMenu.RadioGroup value={projectPath ?? ''} onValueChange={(value) => { selection.projectPath = value || null; selection.branch = ''; }}>
            {#if projectPath && !projects.some((project) => project.path === projectPath)}<DropdownMenu.RadioItem value={projectPath}><span class="truncate">{projectPath}</span></DropdownMenu.RadioItem>{/if}
            {#each projects as project (project.path)}<DropdownMenu.RadioItem value={project.path}><span class="truncate">{project.folderName}</span></DropdownMenu.RadioItem>{/each}
          </DropdownMenu.RadioGroup>
          {#if !projectPath && !projects.length}<DropdownMenu.Item disabled>No projects available</DropdownMenu.Item>{/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    {#if isDev}
      {@render devicePicker(`${pickerId}-simulator`, 'Simulator', simulators, simulator, 'No simulators or emulators on this host', (value) => { selection.simulatorId = value; })}
    {:else}
      <div class="flex min-w-0 flex-col gap-1.5">
        <span id="{pickerId}-branch" class="text-chrome-dense text-(--solus-text-secondary)">Branch</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-branch {pickerId}-branch-value" disabled={active || starting || !branchState?.branches.length}>
                <span id="{pickerId}-branch-value" class="min-w-0 truncate">
                  {#if branchError}Could not load branches
                  {:else if !projectPath}Choose a project first
                  {:else if !branchState}Loading branches…
                  {:else if !branchState.branches.length}No branches available
                  {:else}{selectedBranch}{branchState.branches.includes(selectedBranch) ? '' : ' · unavailable'}{/if}
                </span>
                <ChevronDown class="size-4 text-(--solus-text-secondary)" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="max-h-[min(20rem,var(--bits-dropdown-menu-content-available-height))]">
            <DropdownMenu.RadioGroup value={selectedBranch} onValueChange={(value) => { selection.branch = value; }}>
              {#each branchState?.branches ?? [] as branch (branch)}<DropdownMenu.RadioItem value={branch}><span class="truncate">{branch}</span></DropdownMenu.RadioItem>{/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      {#if branchError}<p role="alert" class="text-chrome-dense text-destructive">{branchError}</p><Button size="sm" variant="outline" onclick={() => projectPath && void devicesStore.loadBranches(serverId, projectPath)}>Try again</Button>{/if}
      <div class="flex min-w-0 flex-col gap-1.5">
        <span id="{pickerId}-target" class="text-chrome-dense text-(--solus-text-secondary)">Build for</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-target {pickerId}-target-value" disabled={active || starting}>
                <span id="{pickerId}-target-value" class="min-w-0 truncate">{TARGET_LABELS[selection.target]}</span>
                <ChevronDown class="size-4 text-(--solus-text-secondary)" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.RadioGroup value={selection.target} onValueChange={(value) => { selection.target = DEVICE_RUN_TARGETS.find((target) => target === value) ?? selection.target; }}>
              {#each DEVICE_RUN_TARGETS as target (target)}<DropdownMenu.RadioItem value={target}>{TARGET_LABELS[target]}</DropdownMenu.RadioItem>{/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <p class="text-chrome-dense text-(--solus-text-tertiary)">
      {#if isDev}Opens the app's debug build on a simulator with this project's dev server. Solus uses the server on port 8081, or starts one. Open it on as many simulators as you like.
      {:else}Builds a Release app from the branch once. Install it on as many devices as you like.{/if}
    </p>
    {#if isDev}
      <Button class="self-start" disabled={cannotOpen} onclick={openOnSimulator}>
        {#if starting}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
        Open on simulator
      </Button>
    {:else}
      <Button class="self-start" disabled={cannotBuild} onclick={build}>
        {#if starting}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
        {output ? 'Build again' : 'Build'}
      </Button>
    {/if}
    {#if error}<p role="alert" class="text-chrome-dense text-destructive">{error}</p>{/if}
  </div>

  {#if latest}
    <DeviceRunLog {serverId} runId={latest.runId} visible class="rounded-lg border border-border" />
  {/if}

  {#if output}
    <div class="flex flex-col gap-3 border-t border-[var(--hairline)] pt-4">
      {@render devicePicker(`${pickerId}-install`, `Install ${output.name} on`, installTargets, installDevice, `No ${TARGET_LABELS[selection.target]} devices on this host`, (value) => { selection.installDeviceId = value; })}
      <div class="flex flex-wrap gap-1">
        <Button size="sm" disabled={!installDevice || !!installDevice.unavailableReason || installing} onclick={() => void install()}>
          {#if installing}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
          Install
        </Button>
        {#if output.assetId}<Button size="sm" variant="ghost" class="text-(--solus-text-secondary)" onclick={() => void download()}><Download />Download APK</Button>{/if}
      </div>
    </div>
  {/if}
</div>
