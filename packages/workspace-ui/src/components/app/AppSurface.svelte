<script lang="ts">
  import { untrack } from "svelte";
  import { LayoutGrid as AppIcon, Play as StartIcon } from "@lucide/svelte";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import type { AppManageSection, RouteParams } from "../../contexts/workspace/routing/route-registry";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
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
  import AppViewStack from "./AppViewStack.svelte";
  import AppViewSwitch from "./AppViewSwitch.svelte";
  import { manageSectionOf } from "./lib/app-manage";
  import {
    APP_HOST_GONE_TEXT,
    APP_NO_UI_TEXT,
    appDeleteConfirmText,
    appSurfacePhase,
    appSurfaceView,
    appProblems,
    problemsTone,
    showsAppViews,
    versionLabel,
    type AppSurfaceView,
  } from "./lib/app-view";

  /**
   * One app (docs/plans/apps.md §9.1): a header with its name, its active
   * version, the switch between App and Manage, and its menu, over the app
   * frame, which gets all of the pane. The route owns the view and the section
   * of the Manage page, so a link opens one and the reader comes back to it.
   */
  let { params, paneId, surfaceVisible = true }: RouteSurfaceProps<"app"> = $props();

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
  const problems = $derived(app ? appProblems(app) : []);
  const view = $derived(appSurfaceView(params.view, app));
  const section = $derived(manageSectionOf(params.section));

  // What the frame needs of the app: the hosts its policy allows, and the host call behind its bridge.
  const frameApp = $derived.by(() => {
    const hostId = serverId;
    const appId = app?.id;
    const network = appState?.network;
    if (!hostId || !appId || !network) return undefined;
    return { network, call: (name: string, argumentsJson: string) => appsStore.call(hostId, appId, name, argumentsJson) };
  });

  let isBusy = $state(false);
  let reloadKey = $state(0);
  /** The Manage page was opened with the keyboard: it takes the keyboard. */
  let manageTakesFocus = $state(false);

  /**
   * Shows one view, in the pane this surface is in. The route keeps the section
   * a reader left while the app shows, so Manage opens on it again.
   */
  function show(nextView: AppSurfaceView, nextSection: AppManageSection | undefined = params.section) {
    const next: RouteParams["app"] = { slug: params.slug };
    if (params.serverId) next.serverId = params.serverId;
    if (nextView === "manage") next.view = "manage";
    if (nextSection) next.section = nextSection;
    session.router.navigate({ name: "app", params: next }, { replace: true, target: pane.isLeading ? "leading" : "companion" });
  }

  function selectView(nextView: AppSurfaceView) {
    manageTakesFocus = false;
    show(nextView);
  }

  function toggleView() {
    if (view === "manage") {
      if (!app?.hasUi) return;
      manageTakesFocus = false;
      show("app");
      requestInputFocus();
      return;
    }
    manageTakesFocus = true;
    show("manage");
  }

  // The key belongs to the app surface that has focus, not to every mounted one.
  const hasFocus = () => surfaceVisible && session.router.focusedPaneId === paneId;
  useScope("app-surface", { active: hasFocus });
  useKeybinding("app-surface.toggle-manage", toggleView, { enabled: () => hasFocus() && app !== undefined });

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
    <span class="min-w-0 flex-1"></span>
    {#if app && serverId}
      <!-- The app's problems are not drawn over the app: the Manage switch has a dot, and the Manage page lists them. -->
      <AppViewSwitch {view} hasUi={app.hasUi} problemCount={problems.length} problemTone={problemsTone(problems)} onSelect={selectView} />
      <AppMenu stopped={app.stopped} disabled={isBusy} onToggleStopped={toggleStopped} onDelete={remove} />
    {/if}
  </div>

  {#if app?.stopped && view === "app"}
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-y border-border/50 px-4 py-2 text-xs text-muted-foreground" role="status">
      <span class="min-w-0 flex-1">This app is stopped. No operation runs, no schedule fires, and no run continues.</span>
      <Button size="xs" variant="outline" disabled={isBusy} onclick={toggleStopped} data-testid="app-surface-start">
        <StartIcon size={12} /> Start
      </Button>
    </div>
  {/if}

  <div class="relative min-h-0 flex-1 overflow-hidden" data-testid="app-surface-body">
    {#if serverId && showsAppViews(phase, app)}
      <!-- One surface can show another app when its route changes: what a reader opened or typed for one app is not the next one's. -->
      {#key `${serverId}\n${app.id}`}
      <AppViewStack {view}>
        {#snippet appContent()}
          {#if phase.kind === "frame" && frameApp}
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
          {:else if phase.kind === "no-ui"}
            <PageEmpty tone="muted" compact title="This app has no UI.">
              {APP_NO_UI_TEXT}
              {#snippet actions()}
                <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => selectView("manage")}>Open Manage</button>
              {/snippet}
            </PageEmpty>
          {:else if phase.kind === "no-version"}
            <PageEmpty tone="muted" compact title="No version of this app runs.">
              {phase.detail}
              {#snippet actions()}
                <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => show("manage", "versions")}>Open Versions</button>
              {/snippet}
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
        {/snippet}
        {#snippet manageContent()}
          <!-- The Manage page brings the diff reader; it loads when the page first opens. -->
          {#await import("./manage/AppManagePage.svelte")}
            <ContentSkeleton label="Loading the Manage page" />
          {:then manageModule}
            {@const AppManagePage = manageModule.default}
            <AppManagePage
              {serverId}
              {app}
              state={appState}
              {problems}
              {section}
              takesFocus={manageTakesFocus}
              busy={isBusy}
              onSelectSection={(next) => show("manage", next)}
              onToggleStopped={toggleStopped}
              onDelete={remove}
            />
          {:catch}
            <div class="flex flex-col items-start gap-2 px-4 py-3" role="alert">
              <span class="text-sm text-destructive">The Manage page did not load.</span>
              <Button size="xs" variant="outline" onclick={retry}>Try again</Button>
            </div>
          {/await}
        {/snippet}
      </AppViewStack>
      {/key}
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
