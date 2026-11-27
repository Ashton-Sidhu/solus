<script lang="ts">
  import { untrack } from "svelte";
  import type { AppWindowRequest } from "@solus/contracts/app-shortcuts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { localApi } from "@solus/client-core/local-api";
  import { serversStore } from "@solus/workspace-ui/contexts";
  import { SettingsContext, setSettingsContext } from "@solus/workspace-ui/contexts/app/settings.context.svelte";
  import { appsStore } from "@solus/workspace-ui/contexts/apps/apps.store.svelte";
  import { appShortcutsStore } from "@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte";
  import SandboxFrame from "@solus/workspace-ui/components/artifact/SandboxFrame.svelte";
  import PageEmpty from "@solus/workspace-ui/components/ui/PageEmpty.svelte";
  import ContentSkeleton from "@solus/workspace-ui/components/ui/ContentSkeleton.svelte";
  import { APP_HOST_GONE_TEXT, APP_NO_UI_TEXT, APP_STOPPED_TEXT, appSurfacePhase } from "@solus/workspace-ui/components/app/lib/app-view";
  import { PAGE_SECONDARY_BTN } from "@solus/workspace-ui/lib/page-chrome";
  import { APP_WINDOW_HOST_UNKNOWN_TEXT, appWindowHost } from "./app-window-host";

  /**
   * The page of an app window (docs/app-shortcuts.md §2): one app in all of
   * the window, with no workspace. It reads the app as the app surface does
   * (`AppSurface.svelte`), through the same stores, and dials only the host of
   * its app. The owner manages the app in the workspace, not here.
   */
  let { request }: { request: AppWindowRequest } = $props();
  const target = untrack(() => ({ host: request.host, appId: request.appId }));

  // The person's theme, fonts, and zoom, as the workspace window paints them.
  const settings = new SettingsContext();
  setSettingsContext(settings);
  $effect(() => localApi.onThemeChange?.((isDark) => settings.setSystemTheme(isDark)));

  // The owner of the host list: a remote host is known when the list names it.
  serversStore.init();
  appShortcutsStore.start();
  $effect(() => appsStore.watch());

  const host = $derived(appWindowHost(serversStore.knownHosts, serversStore.listState, target.host));
  const serverId = $derived(host.kind === "known" ? host.serverId : null);
  $effect(() => {
    const hostId = serverId;
    if (hostId) untrack(() => serverConnections.ensure(hostId));
  });

  const app = $derived(serverId ? appsStore.get(serverId, target.appId)?.app : undefined);
  const appState = $derived(serverId && app ? appsStore.stateFor(serverId, app.id) : undefined);
  const readiness = $derived(serverId ? serversStore.readinessFor(serverId) : null);
  $effect(() => {
    const hostId = serverId;
    const appId = app?.id;
    if (hostId && appId) untrack(() => appsStore.ensure(hostId, appId));
  });
  // The launcher keeps the app's name and icon.
  $effect(() => {
    const hostId = serverId;
    const current = app;
    if (hostId && current && appShortcutsStore.has(target)) untrack(() => void appShortcutsStore.follow(target, hostId, current).catch(() => {}));
  });

  const phase = $derived(
    appSurfacePhase({
      hostPresent: readiness ? readiness.readiness !== "gone" && !readiness.away : true,
      hostStatus: serverId ? appsStore.statusFor(serverId) : "loading",
      app,
      state: appState,
      stateError: serverId && app ? appsStore.stateErrorFor(serverId, app.id) : null,
      ui: serverId && app ? appsStore.uiFor(serverId, app.id, app.activeVersion) : undefined,
      uiError: serverId && app ? appsStore.uiErrorFor(serverId, app.id) : null,
    }),
  );

  const frameApp = $derived.by(() => {
    const hostId = serverId;
    const appId = app?.id;
    const network = appState?.network;
    if (!hostId || !appId || !network) return undefined;
    return { network, call: (name: string, argumentsJson: string) => appsStore.call(hostId, appId, name, argumentsJson) };
  });

  let reloadKey = $state(0);
  let isBusy = $state(false);
  let failure = $state<string | null>(null);

  function retry() {
    reloadKey += 1;
    if (serverId) {
      serverConnections.dialNow(serverId);
      void appsStore.reload(serverId, target.appId);
    }
  }

  async function run(action: () => Promise<void>) {
    if (isBusy) return;
    isBusy = true;
    failure = null;
    try {
      await action();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      isBusy = false;
    }
  }

  function start() {
    const hostId = serverId;
    const appId = app?.id;
    if (hostId && appId) void run(() => appsStore.start(hostId, appId));
  }

  /** The app is gone from its host: its launcher opens nothing. */
  function removeShortcut() {
    void run(async () => {
      await appShortcutsStore.remove(target);
      window.close();
    });
  }
</script>

<svelte:head>
  <title>{app?.name ?? (request.name || "Solus")}</title>
</svelte:head>

<svelte:boundary onerror={(error) => console.error("app window crashed", error)}>
  <div class="flex h-full min-h-0 w-full flex-col bg-(--solus-container-bg) text-(--solus-text-primary)" data-testid="app-window">
    {#if failure}
      <p class="shrink-0 px-4 py-2 text-workspace-chrome text-destructive" role="alert">{failure}</p>
    {/if}
    <div class="relative min-h-0 flex-1 overflow-hidden">
      {#if host.kind === "unknown"}
        <PageEmpty tone="muted" compact title={APP_WINDOW_HOST_UNKNOWN_TEXT}>
          Add the host in Solus, then open this app again.
        </PageEmpty>
      {:else if phase.kind === "host-gone"}
        <PageEmpty tone="muted" compact title={APP_HOST_GONE_TEXT}>
          The app opens again when its host connects.
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={retry}>Try again</button>
          {/snippet}
        </PageEmpty>
      {:else if app?.stopped}
        <PageEmpty tone="muted" compact title="This app is stopped.">
          {APP_STOPPED_TEXT}
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} disabled={isBusy} onclick={start}>Start</button>
          {/snippet}
        </PageEmpty>
      {:else if phase.kind === "frame" && frameApp && serverId && app}
        <div class="flex h-full min-h-0 flex-col">
          <SandboxFrame
            html={phase.ui.html}
            app={frameApp}
            dataVersion={appsStore.dataVersion(serverId, app.id)}
            fillAvailable
            expandable={false}
            lazy={false}
            tooltips={false}
            {reloadKey}
          />
        </div>
      {:else if phase.kind === "no-ui"}
        <PageEmpty tone="muted" compact title="This app has no UI.">{APP_NO_UI_TEXT}</PageEmpty>
      {:else if phase.kind === "no-version"}
        <PageEmpty tone="muted" compact title="No version of this app runs.">{phase.detail}</PageEmpty>
      {:else if phase.kind === "error"}
        <PageEmpty tone="muted" compact title="Could not open this app.">
          {phase.message}
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={retry}>Try again</button>
            {#if !app && appShortcutsStore.has(target)}
              <button type="button" class={PAGE_SECONDARY_BTN} disabled={isBusy} onclick={removeShortcut}>Remove app shortcut</button>
            {/if}
          {/snippet}
        </PageEmpty>
      {:else}
        <ContentSkeleton label="Loading app" preview />
      {/if}
    </div>
  </div>

  {#snippet failed()}
    <PageEmpty tone="muted" compact title="This app window stopped.">Close the window and open the app again.</PageEmpty>
  {/snippet}
</svelte:boundary>
