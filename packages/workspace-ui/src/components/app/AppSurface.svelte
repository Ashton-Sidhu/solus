<script lang="ts">
  import { untrack } from "svelte";
  import { Play as StartIcon } from "@lucide/svelte";
  import { getSettingsContext, getWorkspaceContext, personHistoryStore, serversStore } from "../../contexts";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { appShortcutsStore } from "../../contexts/apps/app-shortcuts.store.svelte";
  import { appIconsStore } from "../../contexts/apps/app-icons.store.svelte";
  import { appMonogram, appTileHue } from "@solus/client-core/app-tile";
  import type { AppManageSection, RouteParams } from "../../contexts/workspace/routing/route-registry";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { appPinOf, isAppPinned, withAppPinned } from "../../lib/sidebar-places";
  import { useKeybinding, useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { toasts } from "../../lib/toasts";
  import { PAGE_SECONDARY_BTN, PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import { underStrip } from "../ui/lib/pane-strip";
  import PaneChrome from "../ui/PaneChrome.svelte";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
  import { Button } from "../ui/button";
  import * as TooltipUI from "../ui/tooltip";
  import SandboxFrame from "../artifact/SandboxFrame.svelte";
  import AppMenu from "./AppMenu.svelte";
  import AppTile from "./AppTile.svelte";
  import AppViewStack from "./AppViewStack.svelte";
  import AppManageToggle from "./AppManageToggle.svelte";
  import { manageSectionOf } from "./lib/app-manage";
  import {
    APP_HOST_GONE_TEXT,
    APP_NO_UI_TEXT,
    APP_STOPPED_TEXT,
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
   * One app (docs/plans/apps.md §9.1): a header with its name, the Manage
   * button, and its menu, over the app frame, which gets all of the pane. The
   * header uses the pills of the other panes, so the app reads as a Solus pane. The route owns the view and the section
   * of the Manage page, so a link opens one and the reader comes back to it.
   */
  let { params, paneId, surfaceVisible = true }: RouteSurfaceProps<"app"> = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const pane = paneActions(() => paneId);
  const isUnderStrip = underStrip();

  $effect(() => appsStore.watch());

  // A link names no host: the first connected host that has the app.
  const serverId = $derived(params.serverId ?? appsStore.hostOf(params.slug));
  const row = $derived(serverId ? appsStore.find(serverId, params.slug) : undefined);
  const app = $derived(row?.app);
  const appState = $derived(serverId && app ? appsStore.stateFor(serverId, app.id) : undefined);
  const readiness = $derived(serverId ? serversStore.readinessFor(serverId) : null);
  // The app's place in the sidebar's places column (docs/plans/sidebar-places-and-sky.md).
  const pin = $derived(serverId && app ? appPinOf(serverId, app.id, serversStore.hostFor(serverId)) : null);
  const isPinned = $derived(pin ? isAppPinned(settings.sidebarApps, pin) : false);
  // The app's own window and its shortcut on this computer (docs/app-shortcuts.md). The pin names the app as they do.
  const hasShortcut = $derived(pin ? appShortcutsStore.has(pin) : false);
  appShortcutsStore.start();
  $effect(() => {
    const target = pin;
    const hostId = serverId;
    const current = app;
    if (target && hostId && current && hasShortcut) untrack(() => void appShortcutsStore.follow(target, hostId, current).catch(() => {}));
  });

  $effect(() => {
    const hostId = serverId;
    const appId = app?.id;
    if (hostId && appId) untrack(() => appsStore.ensure(hostId, appId));
  });
  // Opening an app, from any surface, goes into the person's history (docs/plans/person-state.md).
  $effect(() => {
    const hostId = serverId;
    const appId = app?.id;
    if (hostId && appId) untrack(() => personHistoryStore.record(personHistoryStore.appKey(hostId, appId)));
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

  function togglePinned() {
    if (!pin) return;
    settings.setPersonal("sidebarApps", withAppPinned(settings.sidebarApps, pin, !isPinned));
    requestInputFocus();
  }

  function openWindow() {
    const target = pin;
    const current = app;
    if (target && current) void run(() => appShortcutsStore.openWindow(target, current.name), "The app window did not open");
  }

  function toggleShortcut() {
    const target = pin;
    const hostId = serverId;
    const current = app;
    if (!target || !hostId || !current) return;
    void run(
      async () => {
        if (hasShortcut) {
          await appShortcutsStore.remove(target);
          toasts.info(`The shortcut of ${current.name} was removed from this computer.`);
        } else {
          await appShortcutsStore.add(target, hostId, current);
          toasts.info(`${current.name} has a shortcut on this computer.`);
        }
      },
      hasShortcut ? "The shortcut was not removed" : "The shortcut was not added",
    ).then(() => requestInputFocus());
  }

  function remove() {
    const hostId = serverId;
    const current = app;
    const currentPin = pin;
    if (!hostId || !current || !confirm(appDeleteConfirmText(current.name))) return;
    void run(async () => {
      await appsStore.remove(hostId, current.id);
      if (currentPin) settings.setPersonal("sidebarApps", withAppPinned(settings.sidebarApps, currentPin, false));
      // A shortcut of a deleted app opens nothing.
      if (currentPin && appShortcutsStore.has(currentPin)) await appShortcutsStore.remove(currentPin).catch(() => {});
      pane.close();
    }, "The app was not deleted");
  }
</script>

<!-- The header reserves the raised pane cluster as Files does: the 0.625rem
     right inset, two 1.625rem pills 0.375rem apart, and one more gap, so the
     app's pills and the cluster read as one row. -->
<div
  class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg) {isUnderStrip() ? '' : 'pointer-fine:[--solus-pane-chrome-inset:4.625rem]'}"
  data-testid="app-surface"
>
  <div
    class="workspace-titlebar flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1.5 pl-[max(1rem,var(--solus-chrome-lead-inset,0px))] pr-[max(1rem,var(--solus-pane-chrome-inset,0px))]"
  >
    {#if app && serverId}
      <AppTile monogram={appMonogram(app.name)} hue={appTileHue(app)} iconUrl={appIconsStore.urlFor(serverId, app)} />
    {/if}
    <span
      class="min-w-0 shrink truncate text-workspace-chrome font-medium text-(--solus-text-primary)"
      title={app ? `${app.name} · ${versionLabel(app.activeVersion)}` : undefined}
      data-testid="app-surface-name"
    >
      {app?.name ?? params.slug}
    </span>
    {#if app?.stopped}
      <span class="shrink-0 text-workspace-chrome text-(--solus-text-tertiary)" role="status" data-testid="app-surface-stopped">Stopped</span>
    {/if}
    <span class="min-w-0 flex-1"></span>
    {#if app && serverId}
      {#if app.stopped}
        <TooltipUI.Root>
          <TooltipUI.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="{PAGE_SOFT_ICON_BTN} text-workspace-chrome w-auto! gap-1.5 px-2.5 font-medium disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isBusy}
                onclick={toggleStopped}
                data-testid="app-surface-start"
              >
                <StartIcon size={15} strokeWidth={1.5} aria-hidden="true" />Start
              </button>
            {/snippet}
          </TooltipUI.Trigger>
          <TooltipUI.Content value={APP_STOPPED_TEXT} />
        </TooltipUI.Root>
      {/if}
      <!-- Nothing is drawn over the app for a problem: the Manage button shows it, and the Manage page lists it. -->
      {#if app.hasUi}
        <AppManageToggle {view} problemCount={problems.length} problemTone={problemsTone(problems)} onSelect={selectView} />
      {/if}
      <AppMenu
        stopped={app.stopped}
        pinned={isPinned}
        disabled={isBusy}
        onToggleStopped={toggleStopped}
        onTogglePinned={togglePinned}
        onDelete={remove}
        desktop={appShortcutsStore.isAvailable && app.hasUi && pin ? { hasShortcut, onOpenWindow: openWindow, onToggleShortcut: toggleShortcut } : undefined}
      />
    {/if}
  </div>

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
              pinned={isPinned}
              onSelectSection={(next) => show("manage", next)}
              onToggleStopped={toggleStopped}
              onTogglePinned={togglePinned}
              onOpenApp={app.hasUi ? () => selectView("app") : undefined}
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
  raised="soft"
/>
