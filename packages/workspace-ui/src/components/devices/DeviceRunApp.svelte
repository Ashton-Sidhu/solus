<script lang="ts">
  import { ChevronDown, LoaderCircle } from "@lucide/svelte";
  import { DEVICE_RUN_MODES, DEVICE_RUN_TARGETS, DEVICE_RUN_TARGET_LABELS, isDeviceRunActive, type DeviceRunStartRequest, type DeviceState } from "@solus/contracts/device-types";
  import { isChat } from "@solus/contracts/chat";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { projectsStore } from "../../contexts/projects/projects.store.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as Tabs from "../ui/tabs";
  import DeviceRunLog from "./DeviceRunLog.svelte";
  import DeviceBuildList from "./DeviceBuildList.svelte";
  import { runApps } from "./lib/run-app.svelte";
  import { checkoutPlace } from "../../contexts/workspace/run-location";

  interface Props { serverId: string; sessionId: string | null; deviceState: DeviceState; onInstalled: () => void }
  let { serverId, sessionId, deviceState, onInstalled }: Props = $props();
  const workspace = getWorkspaceContext();
  const pickerId = $props.id();
  const conversation = $derived(sessionId ? workspace.sessions.byId[sessionId]?.run : undefined);
  // One Run app per host: builds and dev servers belong to the host, not to this conversation.
  const runApp = $derived(runApps.for(serverId));
  const conversationProjectPath = $derived(conversation && checkoutPlace(conversation).path !== '~' && !isChat(checkoutPlace(conversation).path) ? checkoutPlace(conversation).path : null);
  const view = $derived(runApp.view(devicesStore.runs(serverId), conversationProjectPath, (path) => devicesStore.branches.get(`${serverId}\u0000${path}`)?.defaultBranch ?? ''));
  const projectPath = $derived(view.projectPath);
  const branchKey = $derived(`${serverId}\u0000${projectPath}`);
  const branchState = $derived(devicesStore.branches.get(branchKey));
  const branchError = $derived(devicesStore.branchErrors.get(branchKey));
  const selectedBranch = $derived(view.branch || branchState?.defaultBranch || '');
  const isDev = $derived(view.mode === 'dev');
  /** True until the host accepts the request. */
  let starting = $state(false);
  let error = $state<string | null>(null);
  const projects = $derived(projectsStore.projectsFor(serverId).filter((project) => !isChat(project.path)));
  const localDevices = $derived(deviceState.devices.filter((device) => device.deviceHostId === 'local'));
  // A dev server reaches only simulators and emulators on this host.
  const simulators = $derived(localDevices.filter((device) => !device.physical));
  const simulator = $derived(simulators.find((candidate) => candidate.deviceId === runApp.simulatorId));
  const latest = $derived(view.latest);
  const active = $derived(!!latest && isDeviceRunActive(latest));
  const devServerRunning = $derived(isDev && latest?.stage === 'running');

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
    void start({ checkoutPath: projectPath, mode: 'device', target: view.target, source: 'main', branch: selectedBranch });
  }
</script>

<div class="@container flex flex-col gap-6 text-workspace-chrome" data-testid="device-run-app">
  <h2 class="font-medium text-(--solus-text-primary)">Run app</h2>

  <Tabs.Root value={view.mode} onValueChange={(value) => { runApp.mode = DEVICE_RUN_MODES.find((mode) => mode === value) ?? runApp.mode; }}>
    <Tabs.List class="w-full">
      <Tabs.Trigger value="dev" disabled={active}>Dev server</Tabs.Trigger>
      <Tabs.Trigger value="device" disabled={active}>Production build</Tabs.Trigger>
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
          <DropdownMenu.RadioGroup value={projectPath ?? ''} onValueChange={(value) => runApp.chooseProject(value || null)}>
            {#if projectPath && !projects.some((project) => project.path === projectPath)}<DropdownMenu.RadioItem value={projectPath}><span class="truncate">{projectPath}</span></DropdownMenu.RadioItem>{/if}
            {#each projects as project (project.path)}<DropdownMenu.RadioItem value={project.path}><span class="truncate">{project.folderName}</span></DropdownMenu.RadioItem>{/each}
          </DropdownMenu.RadioGroup>
          {#if !projectPath && !projects.length}<DropdownMenu.Item disabled>No projects available</DropdownMenu.Item>{/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    {#if isDev}
      <div class="flex min-w-0 flex-col gap-1.5">
        <span id="{pickerId}-simulator" class="text-chrome-dense text-(--solus-text-secondary)">Simulator</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-simulator {pickerId}-simulator-value" disabled={starting}>
                <span id="{pickerId}-simulator-value" class="min-w-0 truncate">{simulator ? `${simulator.name} · ${simulator.platform === 'ios' ? 'iOS' : 'Android'}` : simulators.length ? 'Choose a simulator' : 'No simulators or emulators on this host'}</span>
                <ChevronDown class="size-4 text-(--solus-text-secondary)" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="max-h-[min(20rem,var(--bits-dropdown-menu-content-available-height))]">
            <DropdownMenu.RadioGroup value={simulator?.deviceId ?? ''} onValueChange={(value) => { runApp.simulatorId = value; }}>
              {#each simulators as target (target.deviceId)}<DropdownMenu.RadioItem value={target.deviceId}><span class="truncate">{target.name} · {target.platform === 'ios' ? 'iOS' : 'Android'}</span></DropdownMenu.RadioItem>{/each}
            </DropdownMenu.RadioGroup>
            {#if !simulators.length}<DropdownMenu.Item disabled>No simulators or emulators on this host</DropdownMenu.Item>{/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
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
            <DropdownMenu.RadioGroup value={selectedBranch} onValueChange={(value) => { runApp.branch = value; }}>
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
                <span id="{pickerId}-target-value" class="min-w-0 truncate">{DEVICE_RUN_TARGET_LABELS[view.target]}</span>
                <ChevronDown class="size-4 text-(--solus-text-secondary)" />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.RadioGroup value={view.target} onValueChange={(value) => { runApp.target = DEVICE_RUN_TARGETS.find((target) => target === value) ?? runApp.target; }}>
              {#each DEVICE_RUN_TARGETS as target (target)}<DropdownMenu.RadioItem value={target}>{DEVICE_RUN_TARGET_LABELS[target]}</DropdownMenu.RadioItem>{/each}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-2">
    <p class="text-chrome-dense text-(--solus-text-tertiary)">
      {#if isDev}Opens the app's debug build on a simulator with this project's dev server. Solus uses the server on port 8081, or starts one. Open it on as many simulators as you like.
      {:else}Builds a Release app from the branch. It joins the builds below, where you can install it on several devices at once.{/if}
    </p>
    {#if isDev}
      <Button class="self-start" disabled={cannotOpen} onclick={openOnSimulator}>
        {#if starting}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
        Open on simulator
      </Button>
    {:else}
      <Button class="self-start" disabled={cannotBuild} onclick={build}>
        {#if starting}<LoaderCircle class="animate-spin motion-reduce:animate-none" />{/if}
        Build
      </Button>
    {/if}
    {#if error}<p role="alert" class="text-chrome-dense text-destructive">{error}</p>{/if}
  </div>

  {#if latest && (isDev || latest.stage !== 'done')}
    <DeviceRunLog {serverId} runId={latest.runId} visible
      class="rounded-[var(--tx-card-radius)] bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-quiet-shadow)] data-failed:shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--destructive)_26%,transparent),0_0.0625rem_0.125rem_rgba(60,45,30,0.04)]" />
  {/if}

  {#if !isDev}
    <DeviceBuildList {serverId} {sessionId} {deviceState} {runApp} {onInstalled} />
  {/if}
</div>
