<script lang="ts">
  import {
    Check as CheckIcon,
    HardDrive as DesktopTowerIcon,
    Plus as PlusIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import type { RunConfig } from "@solus/contracts/types";
  import {
    getClientShellContext,
    hostAffinityGlyph,
    projectsStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Button } from "../ui/button";
  import { MenuFooter } from "../ui/menu";
  import {
    serversStore,
    type ServerItem,
    type UnknownRemoteHost,
  } from "../../contexts";
  import {
    projectHostId,
    repoKeyForPath,
    returnsToProjectHome,
    shouldShowRunOnPicker,
    withCheckoutOnHost,
    withRemoteDispatch,
  } from "./run-on";
  import { withPendingHost } from "../../contexts/workspace/run-config";
  import {
    orderRunOnHosts,
    runOnHostAction,
    runOnHostNote,
    type RunOnHostAction,
  } from "./lib/run-on-hosts";
  import {
    canRunOnHost,
    hostIsManaged,
    isManagedHost,
    managedHostStateLabel,
  } from "./lib/managed-host";
  import HostOperatingSystemIcon from "./HostOperatingSystemIcon.svelte";

  interface Props {
    /** Where the next session will run. A started session and a session draft
     *  both hold one, so this picker never asks which it is looking at. */
    run: RunConfig;
    /** Correlates the async pairing flow back to this picker. A tab id for a
     *  conversation, a draft id for a draft — any stable id serves. */
    requesterId: string;
    /** Whether the host is fixed. A started session's is; a draft's never is.
     *  The two variants disagree on the no-session case, so the caller decides
     *  rather than this picker guessing. */
    locked?: boolean;
    /**
     * Where the next session will run, after this picker changes it. Nothing
     * connects, clones or moves here; that is what makes changing your mind
     * free. Send acts on the run.
     */
    onRun: (next: RunConfig) => void;
    /** Pick a folder on a host, for a project with no remote to copy there.
     *  Without it, the host is recorded and the project chip picks the folder. */
    onChooseFolder?: (serverId: string) => void;
    /** Return focus to the composer once the menu closes. */
    onDismiss?: () => void;
    /**
     * `chip` is the standalone "Run on: X" pill the compact status row uses.
     * `header` is the input bar's destination strip chip, which names the host.
     */
    variant?: "chip" | "header";
    /** The pane whose composer this picker belongs to — `undefined` for the
     *  workspace dock, which has none. The open shortcut names a pane, so this
     *  is how the right picker knows the keystroke was meant for it. */
    paneId?: string;
  }

  let {
    run,
    requesterId,
    locked = false,
    onRun,
    onChooseFolder,
    onDismiss,
    variant = "chip",
    paneId,
  }: Props = $props();

  const selectedHostId = $derived(
    run.pendingHostDispatch?.serverId ?? run.serverId ?? LOCAL_SERVER_ID,
  );
  const selectedServer = $derived(serversStore.hostFor(selectedHostId));
  const selectedAffinity = $derived(serversStore.affinityFor(selectedHostId));
  // The OS logo marks a machine you dispatch to; the local host keeps the
  // plain device glyph. A forgotten host has no saved OS and falls back too.
  const selectedHostOs = $derived(
    selectedServer && !selectedServer.local && "os" in selectedServer
      ? selectedServer.os
      : undefined,
  );
  const selectedHostManaged = $derived(hostIsManaged(selectedServer));
  const onRemoteHost = $derived(!!selectedServer && !selectedServer.local);
  // On desktop you are sitting at the machine, so "Local" says it best. A
  // browser has no machine of its own — "Local" would claim the phone in your
  // hand — so the connected host is named instead ("This host" only for the
  // beat before /health answers).
  const shell = getClientShellContext();
  const currentHostId = $derived(run.serverId ?? LOCAL_SERVER_ID);
  const stayLabel = $derived(
    !shell.supportsLocalAttachments
      ? (serversStore.hostFor(currentHostId)?.label ?? "This host")
      : "Local",
  );
  // Reachability, not merely a saved entry, decides whether there is a real
  // machine to run on — so an offline saved host never conjures the picker.
  const showPicker = $derived(
    shouldShowRunOnPicker({
      connectedRemoteCount: serversStore.connectedRemotes.length,
      onRemoteHost,
      selectedHostId,
    }),
  );
  // The project lives where its checkout is, which for a dispatch is its home,
  // not where the agent is headed. Its checkouts on every host come from the
  // catalog, so each row can say what that host would use.
  const projectHost = $derived(projectHostId(run));
  const projectDir = $derived(
    run.projectGroupPath ?? run.gitContext?.repoRoot ?? run.workingDirectory,
  );
  const checkouts = $derived(
    projectDir && projectDir !== "~"
      ? projectsStore.checkoutsOf(projectsStore.projectKeyFor(projectHost, projectDir))
      : [],
  );
  // The repo is resolved against the host the session is already on — a
  // dispatched session's checkout path means nothing in the local manifest.
  const detectedRepoKey = $derived(
    repoKeyForPath(
      serversStore.projectIdentitiesFor(currentHostId),
      run.gitContext?.repoRoot ?? run.workingDirectory,
    ),
  );

  let open = $state(false);
  let triggerEl = $state<HTMLElement | null>(null);
  let triggerTooltipOpen = $state(false);
  let sourceRepoKey = $state<string | null>(null);

  const actionFor = (server: ServerItem): RunOnHostAction =>
    runOnHostAction({
      hostId: server.id,
      selectedHostId,
      run,
      checkouts,
      cloneRepoKey: sourceRepoKey,
    });
  const hosts = $derived(orderRunOnHosts(serversStore.executionServers, actionFor));

  $effect(() => {
    // Retargeting clears gitContext, so retain the last repo key while selection finishes.
    if (detectedRepoKey) sourceRepoKey = detectedRepoKey;
  });

  $effect(() => {
    const path = run.gitContext?.repoRoot ?? run.workingDirectory;
    if (locked || !path || path === "~") return;
    void serversStore.loadProjectIdentities(currentHostId);
  });

  // Reachability decides whether the picker appears at all, so warm it once on
  // mount rather than only when the menu opens. The store's staleness guard
  // collapses the several mounted pickers into a single probe.
  $effect(() => {
    void serversStore.probeHosts();
  });

  // A host paired from the "Add a host" row becomes this run's host.
  $effect(() => {
    const pairedId = serversStore.consumeJustPaired(requesterId);
    if (!pairedId) return;
    const server = serversStore.servers.find(
      (candidate) => candidate.id === pairedId,
    );
    if (server) chooseServer(server);
  });

  // The open shortcut is dispatched by the composer this picker sits under, and
  // names its pane. Only the picker in that pane answers, and only while it is
  // shown and unlocked — the visibility test drops the mirror the hidden layout
  // keeps mounted, so the same keystroke never opens a menu off-screen.
  $effect(() => {
    const handler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if ((detail?.paneId ?? null) !== (paneId ?? null)) return;
      if (!showPicker || locked) return;
      if (triggerEl && triggerEl.offsetParent === null) return;
      open = !open;
    };
    window.addEventListener("solus:toggle-run-picker", handler);
    return () => window.removeEventListener("solus:toggle-run-picker", handler);
  });

  /**
   * A host is named for where the work runs, and "runs here" is what local
   * means — the device's own name ("This Mac") is only interesting on surfaces
   * that list it beside other people's machines. A managed host's row already
   * reads its own name (`hostRowLabel`) and never names its organization.
   */
  function hostLabel(server: ServerItem | UnknownRemoteHost | null | undefined) {
    return !server || server.local ? stayLabel : server.label;
  }

  /** Every row does what it said it would. Only intent is recorded; Send acts. */
  function chooseServer(server: ServerItem) {
    if (locked) return;
    const action = actionFor(server);
    open = false;
    switch (action.kind) {
      case "current":
        return;
      case "checkout":
        onRun(
          withCheckoutOnHost(run, server.id, action.path, {
            immediate: server.local || returnsToProjectHome(run, server.id),
            isolate: serversStore.isolatesSessions(server.id),
          }),
        );
        return;
      case "clone":
        // The repository travels as a clone; the project, and every task it
        // files, stays where it is.
        if (!sourceRepoKey) return;
        onRun(
          withRemoteDispatch(run, {
            serverId: server.id,
            intent: "dispatch",
            repoKey: sourceRepoKey,
          }),
        );
        return;
      case "choose-folder":
        if (onChooseFolder) onChooseFolder(server.id);
        else onRun(withPendingHost(run, { serverId: server.id, intent: "open-project" }));
        return;
    }
  }

  function addHost() {
    open = false;
    serversStore.pairForRunOn(requesterId);
    serversStore.openAddServer();
  }

  function handleOpenChange(next: boolean) {
    open = next;
    if (next) {
      triggerTooltipOpen = false;
      void serversStore.probeHosts();
    }
  }

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    if (onDismiss) onDismiss();
    else requestInputFocus();
  }

  function getTriggerTooltipOpen() {
    return triggerTooltipOpen && !open;
  }

  function setTriggerTooltipOpen(next: boolean) {
    triggerTooltipOpen = next && !open;
  }
</script>

{#snippet serverRow(server: ServerItem)}
  {@const action = actionFor(server)}
  {@const isSelectedHost = action.kind === "current"}
  {@const affinity = hostAffinityGlyph(server, server.status)}
  <!-- A managed host that is not ready says its state and takes no work;
       every other row says what that host will use for this project. -->
  {@const subtitle = managedHostStateLabel(server.uplink) ?? runOnHostNote(action)}
  <DropdownMenu.Item
    data-menu-current={isSelectedHost ? "" : undefined}
    disabled={!canRunOnHost(server.uplink)}
    onSelect={() => chooseServer(server)}
  >
    {#if affinity}
      {@const HostIcon = affinity.icon}
      <HostIcon size={14} class="shrink-0 {affinity.className}" />
    {:else if !server.local && (server.os || isManagedHost(server.uplink))}
      <HostOperatingSystemIcon
        os={server.os}
        managed={isManagedHost(server.uplink)}
        size={14}
        class="shrink-0 text-(--solus-text-tertiary)"
      />
    {:else}
      <DesktopTowerIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
    {/if}
    {#if subtitle}
      <span class="flex min-w-0 flex-1 flex-col leading-tight">
        <span class="truncate">{hostLabel(server)}</span>
        <span class="truncate text-xs text-(--solus-text-tertiary)">{subtitle}</span>
      </span>
    {:else}
      <span class="min-w-0 flex-1 truncate">{hostLabel(server)}</span>
    {/if}
    {#if isSelectedHost}
      <CheckIcon size={14} class="shrink-0 text-(--solus-accent)" />
    {:else if affinity && server.status !== "saved"}
      <span class="shrink-0 text-xs text-(--solus-text-tertiary)">{affinity.statusLabel}</span>
    {/if}
  </DropdownMenu.Item>
{/snippet}

<!-- Shown when there is a real choice about where work runs: a reachable
     remote, or a run that already names one. One machine has no choice, so the
     picker stays out of the way until a host connects. -->
{#if showPicker}
  {#if locked}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <span
            {...tooltipProps}
            aria-label={`Runs on ${selectedServer ? hostLabel(selectedServer) : "an unknown host"}`}
            class="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary)"
          >
            {#if selectedAffinity}
              {@const HostIcon = selectedAffinity.icon}
              <HostIcon
                size={14}
                class="shrink-0 {selectedAffinity.className}"
              />
            {:else if selectedHostOs || selectedHostManaged}
              <HostOperatingSystemIcon
                os={selectedHostOs} managed={selectedHostManaged}
                size={14}
                class="shrink-0"
              />
            {:else}
              <DesktopTowerIcon size={14} class="shrink-0 opacity-60" />
            {/if}
          </span>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={`Runs on ${selectedServer ? hostLabel(selectedServer) : "an unknown host"} — sessions stay on the host they started on`}
      />
    </TooltipUI.Root>
  {:else}
    <DropdownMenu.Root bind:open onOpenChange={handleOpenChange}>
      <DropdownMenu.Trigger bind:ref={triggerEl}>
        {#snippet child({ props })}
          {#if variant === "header"}
            <TooltipUI.Root
              bind:open={getTriggerTooltipOpen, setTriggerTooltipOpen}
              disabled={open}
            >
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <!-- A phone gives the destination strip about 412px of usable
                       row. At 11rem the host name alone pushes the task chip
                       onto a second line, so a thumb-sized client caps it at
                       8rem: a hostname truncates, but project, branch, and task
                       stay on one readable line. -->
                  <Button
                    {...mergeProps(tooltipProps, props)}
                    variant="ghost"
                    class="group relative h-auto max-w-44 gap-1.5 rounded-lg px-2 py-1 text-workspace-chrome pointer-coarse:max-w-32 font-normal transition-[background-color,color,scale] duration-[var(--duration-quick)] ease-(--ease-premium) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-0 after:absolute after:left-0 after:top-1/2 after:h-10 after:w-full after:-translate-y-1/2 after:content-[''] {open
 ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
 : 'text-(--solus-text-tertiary) hover:bg-[color-mix(in_srgb,var(--solus-surface-hover)_60%,transparent)] hover:text-(--solus-text-secondary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-secondary)'}"
                  >
                    {#if onRemoteHost && selectedAffinity}
                      {@const HostIcon = selectedAffinity.icon}
                      <HostIcon
                        size={14}
                        class="shrink-0 transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'} {selectedAffinity.className}"
                      />
                    {:else if selectedHostOs || selectedHostManaged}
                      <HostOperatingSystemIcon
                        os={selectedHostOs} managed={selectedHostManaged}
                        size={14}
                        class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'}"
                      />
                    {:else}
                      <DesktopTowerIcon
                        size={14}
                        class="shrink-0 text-(--solus-text-tertiary) transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 {open
 ? 'opacity-100'
 : 'opacity-70'}"
                      />
                    {/if}
                    <span class="truncate">{hostLabel(selectedServer)}</span>
                  </Button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={`Where the next session runs — now: ${hostLabel(selectedServer)}`}
              />
            </TooltipUI.Root>
          {:else}
            <TooltipUI.Root
              bind:open={getTriggerTooltipOpen, setTriggerTooltipOpen}
              disabled={open}
            >
              <TooltipUI.Trigger>
                {#snippet child({ props: tooltipProps })}
                  <Button
                    {...mergeProps(tooltipProps, props)}
                    variant="ghost"
                    aria-label={`Run new session on ${hostLabel(selectedServer)}`}
                    class="relative size-7 rounded-full p-0 text-(--solus-text-tertiary) transition-[background-color,color,scale] hover:bg-[color-mix(in_srgb,var(--solus-accent)_7%,transparent)] hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:ring-0 after:absolute after:left-1/2 after:top-1/2 after:size-10 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
                  >
                    {#if selectedAffinity}
                      {@const HostIcon = selectedAffinity.icon}
                      <HostIcon
                        size={14}
                        class="shrink-0 {selectedAffinity.className}"
                      />
                    {:else if selectedHostOs || selectedHostManaged}
                      <HostOperatingSystemIcon
                        os={selectedHostOs} managed={selectedHostManaged}
                        size={14}
                        class="shrink-0"
                      />
                    {:else}
                      <DesktopTowerIcon size={14} class="shrink-0 opacity-60" />
                    {/if}
                  </Button>
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content
                value={`Run new session on ${hostLabel(selectedServer)}`}
              />
            </TooltipUI.Root>
          {/if}
        {/snippet}
      </DropdownMenu.Trigger>
      <!-- Both triggers live on the bottom-anchored composer, so downward is
           where there is no room; the list opens over the transcript instead. -->
      <DropdownMenu.Content
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onCloseAutoFocus={handleCloseAutoFocus}
        class="w-[300px] p-0 text-workspace-chrome [&_.menu-row]:text-workspace-chrome"
      >
        <!-- The footer spans the surface, so the rows scroll inside their own
             padded body rather than dragging it out of view. -->
        <div class="max-h-[288px] overflow-y-auto p-1.5">
          <DropdownMenu.Label>Run on</DropdownMenu.Label>
          {#each hosts as server (server.id)}
            {@render serverRow(server)}
          {/each}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={addHost}>
            <PlusIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
            <span class="min-w-0 flex-1 truncate">Add a host…</span>
          </DropdownMenu.Item>
        </div>
        <MenuFooter hints={[["⏎", "select"]]} summary={hostLabel(selectedServer)} />
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
{/if}
