<script lang="ts">
  import { ChevronDown, LoaderCircle } from "@lucide/svelte";
  import { DEVICE_RUN_TARGETS, DEVICE_RUN_TARGET_LABELS, isDeviceRunActive, type DeviceRunStartRequest, type DeviceState } from "@solus/contracts/device-types";
  import { isChat } from "@solus/contracts/chat";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { devicesStore, deviceErrorMessage } from "../../contexts/devices/devices.store.svelte";
  import { projectsStore } from "../../contexts/projects/projects.store.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import DeviceRunLog from "./DeviceRunLog.svelte";
  import DeviceBuildList from "./DeviceBuildList.svelte";
  import { runApps } from "./lib/run-app.svelte";
  import { checkoutPlace } from "../../contexts/workspace/run-location";

  interface Props { serverId: string; sessionId: string | null; deviceState: DeviceState; onInstalled: () => void }
  let { serverId, sessionId, deviceState, onInstalled }: Props = $props();
  const workspace = getWorkspaceContext();
  const pickerId = $props.id();
  const conversation = $derived(sessionId ? workspace.sessions.byId[sessionId]?.run : undefined);
  // Build choices belong to the host, not to this conversation.
  const runApp = $derived(runApps.for(serverId));
  const conversationProjectPath = $derived(conversation && checkoutPlace(conversation).path !== '~' && !isChat(checkoutPlace(conversation).path) ? checkoutPlace(conversation).path : null);
  const view = $derived(runApp.view(devicesStore.runs(serverId), conversationProjectPath, (path) => devicesStore.branches.get(`${serverId}\u0000${path}`)?.defaultBranch ?? ''));
  const projectPath = $derived(view.projectPath);
  const branchKey = $derived(`${serverId}\u0000${projectPath}`);
  const branchState = $derived(devicesStore.branches.get(branchKey));
  const branchError = $derived(devicesStore.branchErrors.get(branchKey));
  const selectedBranch = $derived(view.branch || branchState?.defaultBranch || '');
  /** True until the host accepts the request. */
  let starting = $state(false);
  let error = $state<string | null>(null);
  const projects = $derived(projectsStore.projectsFor(serverId).filter((project) => !isChat(project.path)));
  const latest = $derived(view.latest);
  const active = $derived(!!latest && isDeviceRunActive(latest));

  $effect(() => {
    void projectsStore.loadProjectsFor(serverId, serverConnections.apiFor(serverId));
    void devicesStore.refresh(serverId).catch(() => {});
  });

  $effect(() => {
    if (projectPath) void devicesStore.loadBranches(serverId, projectPath);
  });

  const hasBranch = $derived(!!branchState?.branches.includes(selectedBranch));
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

  function build() {
    if (!projectPath || cannotBuild) return;
    void start({ checkoutPath: projectPath, mode: 'device', target: view.target, source: 'main', branch: selectedBranch });
  }
</script>

<div class="@container flex flex-col gap-6 text-workspace-chrome" data-testid="device-run-app">
  <header class="flex flex-col gap-1.5">
    <h2 class="font-medium text-(--solus-text-primary)">Production builds</h2>
    <p class="text-chrome-dense text-pretty text-(--solus-text-secondary)">Build a Release app from a branch, then install it on your devices.</p>
  </header>

  <section class="flex flex-col gap-4" aria-labelledby="{pickerId}-new-build">
    <h3 id="{pickerId}-new-build" class="font-medium text-(--solus-text-primary)">New build</h3>
    <div class="flex flex-col gap-3">
      <div class="flex min-w-0 flex-col gap-1.5">
        <span id="{pickerId}-project" class="text-chrome-dense text-(--solus-text-secondary)">Project</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-project {pickerId}-project-value" disabled={active || starting}>
                <span id="{pickerId}-project-value" class="min-w-0 truncate">{projects.find((project) => project.path === projectPath)?.folderName ?? projectPath ?? 'Choose a project'}</span>
                <ChevronDown class="size-4 shrink-0 text-(--solus-text-secondary)" />
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

      <div class="grid min-w-0 gap-3 @sm:grid-cols-2">
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
                  <ChevronDown class="size-4 shrink-0 text-(--solus-text-secondary)" />
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
        <div class="flex min-w-0 flex-col gap-1.5">
          <span id="{pickerId}-target" class="text-chrome-dense text-(--solus-text-secondary)">Build for</span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button {...props} variant="outline" class="h-auto w-full justify-between px-3 py-2 font-normal pointer-coarse:py-3" aria-labelledby="{pickerId}-target {pickerId}-target-value" disabled={active || starting}>
                  <span id="{pickerId}-target-value" class="min-w-0 truncate">{DEVICE_RUN_TARGET_LABELS[view.target]}</span>
                  <ChevronDown class="size-4 shrink-0 text-(--solus-text-secondary)" />
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
      </div>
      {#if branchError}<p role="alert" class="text-chrome-dense text-destructive">{branchError}</p><Button size="sm" variant="outline" onclick={() => projectPath && void devicesStore.loadBranches(serverId, projectPath)}>Try again</Button>{/if}
    </div>

    <div class="flex flex-col gap-2">
      <p class="text-chrome-dense text-pretty text-(--solus-text-tertiary)">Uses the latest committed code on the selected branch. Your working files stay unchanged.</p>
      <Button class="self-start" disabled={cannotBuild} onclick={build}>
        {#if starting || active}<LoaderCircle class="size-4 shrink-0 animate-spin motion-reduce:animate-none" />{/if}
        {starting ? 'Starting build…' : active ? (latest?.mode === 'dev' ? 'Run in progress…' : 'Building Release app…') : 'Build Release app'}
      </Button>
      {#if error}<p role="alert" class="text-chrome-dense text-destructive">{error}</p>{/if}
    </div>
  </section>

  {#if active && latest?.mode === 'dev'}
    <p role="status" class="text-chrome-dense text-(--solus-text-secondary)">Stop the active dev server below before starting a production build.</p>
  {/if}
  {#if latest}
    <DeviceRunLog {serverId} runId={latest.runId} visible
      class="rounded-[var(--tx-card-radius)] bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-quiet-shadow)] data-failed:shadow-[shadow:0_0_0_0.03125rem_color-mix(in_oklch,var(--destructive)_26%,transparent),0_0.0625rem_0.125rem_rgba(60,45,30,0.04)]" />
  {/if}

  <DeviceBuildList {serverId} {sessionId} {deviceState} {runApp} {onInstalled} />
</div>
