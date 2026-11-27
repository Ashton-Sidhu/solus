<script lang="ts">
  import { untrack } from "svelte";
  import type { AppWindowRequest } from "@solus/contracts/app-shortcuts";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { localApi } from "@solus/client-core/local-api";
  import { serversStore } from "@solus/workspace-ui/contexts";
  import { SettingsContext, setSettingsContext } from "@solus/workspace-ui/contexts/app/settings.context.svelte";
  import { appsStore } from "@solus/workspace-ui/contexts/apps/apps.store.svelte";
  import { appShortcutsStore } from "@solus/workspace-ui/contexts/apps/app-shortcuts.store.svelte";
  import { removalMessage, shortcutCommandLabel, trashName } from "@solus/workspace-ui/contexts/apps/app-shortcut-messages";
  import { CURRENT_KEYS } from "@solus/workspace-ui/lib/keybindings/key-platform";
  import { accountStore } from "@solus/workspace-ui/contexts/account/account.store.svelte";
  import SandboxFrame from "@solus/workspace-ui/components/artifact/SandboxFrame.svelte";
  import PageEmpty from "@solus/workspace-ui/components/ui/PageEmpty.svelte";
  import ContentSkeleton from "@solus/workspace-ui/components/ui/ContentSkeleton.svelte";
  import { APP_HOST_GONE_TEXT, APP_MISSING_TEXT, APP_NO_UI_TEXT, APP_STOPPED_TEXT, appSurfacePhase } from "@solus/workspace-ui/components/app/lib/app-view";
  import { PAGE_SECONDARY_BTN } from "@solus/workspace-ui/lib/page-chrome";
  import type { AppShortcutOffer } from "@solus/contracts/app-shortcuts";
  import { appGoneTitle, appWindowHost, appWindowHostGapView, checkLinkAddress, type LinkAddressCheck } from "./app-window-host";

  /**
   * The page of an app window (docs/app-shortcuts.md §2): one app in all of
   * the window, with no workspace. It reads the app as the app surface does
   * (`AppSurface.svelte`), through the same stores, and dials only the host of
   * its app. The owner manages the app in the workspace, not here. A
   * shortcut link opens it with an offer: the window asks to add the shortcut
   * once the app shows, and says why when this computer does not know the
   * app's host (§5).
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
  accountStore.start();
  $effect(() => appsStore.watch());

  // The offer of a shortcut link; a link for this app while its window is open asks again.
  let offer = $state<AppShortcutOffer | null>(untrack(() => request.offer ?? null));
  let isOfferDismissed = $state(false);
  $effect(() =>
    localApi.onAppShortcutOffer?.((next) => {
      offer = next;
      isOfferDismissed = false;
    }),
  );

  const account = $derived({
    hasAnswered: accountStore.hasAnswered,
    subject: accountStore.state.kind === "signed-in" ? accountStore.state.identity.sub : null,
  });
  const host = $derived(appWindowHost(serversStore.knownHosts, serversStore.listState, target.host, offer, account));

  // The link's address is a hint: the window offers to add that host only when it answers as the host the link names.
  let addressCheck = $state<LinkAddressCheck>("checking");
  const checkedAddress = $derived(host.kind === "unknown" && host.reason === "not-added" ? (offer?.address ?? null) : null);
  $effect(() => {
    const address = checkedAddress;
    if (!address) return;
    const controller = new AbortController();
    addressCheck = "checking";
    void checkLinkAddress(fetch, address, target.host, controller.signal).then((check) => {
      if (!controller.signal.aborted) addressCheck = check;
    });
    return () => controller.abort();
  });
  const gap = $derived(host.kind === "unknown" ? appWindowHostGapView(host.reason, offer?.address ?? null, addressCheck, request.name) : null);
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
  const hasShortcut = $derived(appShortcutsStore.has(target));
  const shortcutChange = $derived(appShortcutsStore.changeFor(target));
  let notice = $state<string | null>(null);

  const offerShows = $derived(
    !!offer && !isOfferDismissed && phase.kind === "frame" && !!app && !hasShortcut,
  );

  /** The person confirms the shortcut here, where the host's own name of the app shows: a link never adds it. */
  function addShortcut() {
    const hostId = serverId;
    const current = app;
    if (!hostId || !current) return;
    void run(async () => {
      await appShortcutsStore.add(target, hostId, current);
      notice = `${current.name} has an app shortcut on this computer.`;
    });
  }

  function dismissOffer() {
    isOfferDismissed = true;
  }

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

  /** The host list and the sign-in are read once per page; a new page reads them again. */
  function retryHost() {
    location.reload();
  }

  /** The app or its host is gone: its launcher opens nothing. A launcher that the Trash refused stays, and the window says where. */
  function removeShortcut() {
    void run(async () => {
      const removal = await appShortcutsStore.remove(target);
      if (!removal) return;
      if (removal.launcher !== "kept") {
        window.close();
        return;
      }
      const { message, description } = removalMessage(app?.name ?? (request.name || "this app"), removal, trashName(CURRENT_KEYS.id));
      failure = `${message} ${description ?? ""}`;
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
    {#if notice}
      <p class="shrink-0 px-4 py-2 text-workspace-chrome text-(--solus-text-secondary)" role="status">{notice}</p>
    {/if}
    {#if offerShows && app}
      <!-- Escape is Not now. The question takes the keyboard when it shows: the next step is to answer it. -->
      <div
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--hairline) px-4 py-2"
        role="region"
        aria-label="Add app shortcut"
        data-testid="app-window-shortcut-offer"
        onkeydown={(event) => {
          if (event.key === "Escape") dismissOffer();
        }}
      >
        <p class="min-w-0 flex-1 text-workspace-chrome text-(--solus-text-primary)">
          Add an app shortcut for {app.name}? It shows where this computer lists apps, and opens {app.name} in its own window.
        </p>
        <button type="button" class={PAGE_SECONDARY_BTN} onclick={dismissOffer}>Not now</button>
        <button type="button" class={PAGE_SECONDARY_BTN} disabled={isBusy} onclick={addShortcut} {@attach (button) => button.focus()}>
          Add app shortcut
        </button>
      </div>
    {/if}
    <div class="relative min-h-0 flex-1 overflow-hidden">
      {#if gap}
        {@const action = gap.action}
        <PageEmpty tone="muted" compact title={gap.title}>
          {gap.body}
          {#snippet actions()}
            {#if action}
              <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => localApi.requestWorkspace?.(action.request)}>{action.label}</button>
            {/if}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={retryHost}>Try again</button>
            {#if hasShortcut || shortcutChange}
              <button type="button" class={PAGE_SECONDARY_BTN} disabled={isBusy || shortcutChange !== null} onclick={removeShortcut}>
                {shortcutCommandLabel(true, shortcutChange)}
              </button>
            {/if}
          {/snippet}
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
        <PageEmpty tone="muted" compact title={!app && phase.message === APP_MISSING_TEXT ? appGoneTitle(request.name) : "Could not open this app."}>
          {phase.message}
          {#snippet actions()}
            <button type="button" class={PAGE_SECONDARY_BTN} onclick={retry}>Try again</button>
            {#if !app && (hasShortcut || shortcutChange)}
              <button type="button" class={PAGE_SECONDARY_BTN} disabled={isBusy || shortcutChange !== null} onclick={removeShortcut}>
                {shortcutCommandLabel(true, shortcutChange)}
              </button>
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
