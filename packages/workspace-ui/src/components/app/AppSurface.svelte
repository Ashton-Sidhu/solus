<script lang="ts">
  import { untrack } from "svelte";
  import { LayoutGrid as AppIcon, Play as StartIcon, TriangleAlert as AttentionIcon } from "@lucide/svelte";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { Button } from "../ui/button";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import AppMenu from "./AppMenu.svelte";
  import AppOperations from "./AppOperations.svelte";
  import {
    APP_HOST_GONE_TEXT,
    appDeleteConfirmText,
    appSurfacePhase,
    headerAttention,
    unsetSecretCount,
    versionLabel,
    type AppMenuSection,
  } from "./lib/app-view";

  /**
   * One app (docs/plans/apps.md §9): a header with its name, its active
   * version, and its menu, over the app frame, which gets all of the pane. An app with no UI shows its operations.
   */
  let { params, paneId }: RouteSurfaceProps<"app"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(() => paneId);

  $effect(() => appsStore.watch());

  // A link names no host: the first connected host that has the app.
  const serverId = $derived(params.serverId ?? appsStore.hostOf(params.slug));
  const row = $derived(serverId ? appsStore.find(serverId, params.slug) : undefined);
  const app = $derived(row?.app);
  const appState = $derived(serverId && app ? appsStore.stateFor(serverId, app.id) : undefined);
  const readiness = $derived(serverId ? serversStore.readinessFor(serverId) : null);

  $effect(() => {
    const hostId = serverId;
    const appId = app?.id;
    if (hostId && appId) untrack(() => appsStore.ensure(hostId, appId));
  });

  const phase = $derived(
    appSurfacePhase({
      // Without a host, the hosts that still read their lists decide between loading and missing.
      hostPresent: readiness ? readiness.readiness !== "gone" && !readiness.away : true,
      hostStatus: serverId ? appsStore.statusFor(serverId) : appsStore.isSettled ? "ready" : "loading",
      app,
      state: appState,
      stateError: serverId && app ? appsStore.stateErrorFor(serverId, app.id) : null,
      ui: serverId && app ? appsStore.uiFor(serverId, app.id, app.activeVersion) : undefined,
      uiError: serverId && app ? appsStore.uiErrorFor(serverId, app.id) : null,
    }),
  );
  const attention = $derived(app ? headerAttention(app) : []);

  // What the frame needs of the app: the hosts its policy allows, and the host call behind its bridge.
  const frameApp = $derived.by(() => {
    const hostId = serverId;
    const appId = app?.id;
    const network = appState?.network;
    if (!hostId || !appId || !network) return undefined;
    return { network, call: (name: string, argumentsJson: string) => appsStore.call(hostId, appId, name, argumentsJson) };
  });

  let menuSection = $state<AppMenuSection | null>(null);
  let isBusy = $state(false);
  let reloadKey = $state(0);

  function closeMenu() {
    menuSection = null;
    requestInputFocus();
  }

  function retry() {
    reloadKey += 1;
    if (serverId) void appsStore.reload(serverId, params.slug);
    else void appsStore.loadAll();
  }

  async function run(action: () => Promise<void>, failure: string) {
    if (isBusy) return;
    isBusy = true;
    try {
      await action();
    } catch (error) {
      toasts.error(failure, { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isBusy = false;
    }
  }

  function toggleStopped() {
    const hostId = serverId;
    const current = app;
    if (!hostId || !current) return;
    void run(
      () => (current.stopped ? appsStore.start(hostId, current.id) : appsStore.stop(hostId, current.id)),
      current.stopped ? "The app did not start" : "The app did not stop",
    ).then(() => requestInputFocus());
  }

  function remove() {
    const hostId = serverId;
    const current = app;
    if (!hostId || !current || !confirm(appDeleteConfirmText(current.name))) return;
    void run(async () => {
      await appsStore.remove(hostId, current.id);
      pane.close();
    }, "The app was not deleted");
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg)" data-testid="app-surface">
  <div
    class="workspace-titlebar flex h-auto min-h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-2 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))]"
  >
    <AppIcon size={16} strokeWidth={1.75} class="shrink-0 text-muted-foreground" aria-hidden="true" />
    <span class="min-w-0 shrink truncate text-workspace-chrome font-medium text-(--solus-text-primary)" data-testid="app-surface-name">
      {app?.name ?? params.slug}
    </span>
    {#if app}
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="app-surface-version">{versionLabel(app.activeVersion)}</span>
    {/if}
    <!-- What the app may use is in the menu's Versions list, with each version. -->
    <span class="min-w-0 flex-1"></span>
    {#if app && serverId}
      <AppMenu
        stopped={app.stopped}
        unsetSecrets={unsetSecretCount(app)}
        disabled={isBusy}
        onOpenSection={(section) => (menuSection = section)}
        onToggleStopped={toggleStopped}
        onDelete={remove}
      />
    {/if}
  </div>

  {#if attention.length > 0}
    <ul class="m-0 flex shrink-0 list-none flex-col gap-0.5 px-4 pb-2" aria-label="What needs you">
      {#each attention as item (item.kind + item.detail)}
        <li class="flex min-w-0 items-start gap-1.5 text-xs text-(--warning)">
          <AttentionIcon size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 text-pretty">{item.detail}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if app?.stopped}
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-y border-border/50 px-4 py-2 text-xs text-muted-foreground" role="status">
      <span class="min-w-0 flex-1">This app is stopped. No operation runs and no schedule fires.</span>
      <Button size="xs" variant="outline" disabled={isBusy} onclick={toggleStopped} data-testid="app-surface-start">
        <StartIcon size={12} /> Start
      </Button>
    </div>
  {/if}

  <div class="relative min-h-0 flex-1 overflow-hidden" data-testid="app-surface-body">
    {#if phase.kind === "frame" && frameApp && serverId && app}
      <!-- The app gets all of the pane, with no padding: its UI scrolls inside its own frame. -->
      <div class="flex h-full min-h-0 flex-col">
        <SandboxFrame
          html={phase.ui.html}
          app={frameApp}
          dataVersion={appsStore.dataVersion(serverId, app.id)}
          fillAvailable
          expandable={false}
          lazy={false}
          {reloadKey}
        />
      </div>
    {:else if phase.kind === "operations"}
      <AppOperations state={phase.state} />
    {:else if phase.kind === "no-version"}
      <PageEmpty tone="muted" compact title="No version of this app runs.">
        {phase.detail}
      </PageEmpty>
    {:else if phase.kind === "host-gone"}
      <PageEmpty tone="muted" compact title={APP_HOST_GONE_TEXT}>
        The app opens again when its host connects.
      </PageEmpty>
    {:else if phase.kind === "error"}
      <PageEmpty tone="muted" compact title="Could not open this app.">
        {phase.message}
        {#snippet actions()}
          <button type="button" class={PAGE_SECONDARY_BTN} onclick={retry}>Try again</button>
        {/snippet}
      </PageEmpty>
    {:else}
      <ContentSkeleton label="Loading app" preview />
    {/if}

    {#if menuSection && app && serverId}
      <!-- The menu's sections bring the diff reader; they load when the menu first opens. -->
      {#await import("./AppMenuPanel.svelte")}
        <div class="absolute inset-0 z-10 bg-(--solus-container-bg)" role="status" aria-busy="true" aria-label="Loading the app menu"></div>
      {:then menuModule}
        {@const AppMenuPanel = menuModule.default}
        <AppMenuPanel bind:section={menuSection} {serverId} {app} state={appState} onClose={closeMenu} />
      {:catch}
        <div class="absolute inset-0 z-10 flex flex-col items-start gap-2 bg-(--solus-container-bg) px-4 py-3" role="alert">
          <span class="text-sm text-destructive">The app menu did not load.</span>
          <Button size="xs" variant="outline" onclick={closeMenu}>Back to the app</Button>
        </div>
      {/await}
    {/if}
  </div>
</div>
<!-- After the content, as the other surfaces do: the cluster's no-drag holes
     must come after any drag rect. Under the strip it draws nothing. -->
<PaneChrome
  onClose={pane.close}
  onToggleMaximize={pane.toggleMaximize}
  maximized={pane.maximized}
  closeLabel="Close app"
/>
