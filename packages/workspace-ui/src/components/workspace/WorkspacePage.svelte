<script lang="ts">
  import { accountStore } from "../../contexts/account/account.store.svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { tick, untrack } from "svelte";
  import {
    LibraryBig as BooksIcon,
    ChevronDown as CaretDownIcon,
    ChevronRight as CaretRightIcon,
    MessagesSquare as SharedSessionsIcon,
    Plus as PlusIcon,
    PanelLeft as SidebarSimpleIcon,
    Users as SharedIcon,
  } from "@lucide/svelte";
  import type { WorkListing } from "../../contexts/works/works.store.svelte";
  import {
    getClientShellContext,
    getSurfaceContext,
    runtime,
    presenceStore,
    projectsStore,
    serversStore,
    sharesStore,
  } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { liveSessionTitle } from "../../lib/sessionUtils";
  import { SessionUnavailableError } from "../../contexts/workspace/session-errors";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { PAGE_PRIMARY_BTN, PAGE_SECONDARY_BTN } from "../../lib/page-chrome";
  import { PageCrumbLine, syncStamp } from "../ui/list-page";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import WorkspaceAppsTab from "./WorkspaceAppsTab.svelte";
  import WorkspaceFilterControls from "./WorkspaceFilterControls.svelte";
  import WorkspaceCard from "./WorkspaceCard.svelte";
  import WorkspaceSessionCard from "./WorkspaceSessionCard.svelte";
  import WorkspaceTabStrip from "./WorkspaceTabStrip.svelte";
  import WorkspaceNewMenu from "./WorkspaceNewMenu.svelte";
  import WorkspaceItemContextMenu from "./WorkspaceItemContextMenu.svelte";
  import WorkspacePeek from "./WorkspacePeek.svelte";
  import ImportDocDialog from "../work/ImportDocDialog.svelte";
  import { copyWorkReviewLink, openWorkReview } from "../work/lib/work-review-commands";
  import type { DocProviderId } from "@solus/contracts/docs";
  import WorkspaceSearchField from "./WorkspaceSearchField.svelte";
  import { sessionListStore } from "../../contexts/workspace/session-list.store.svelte";
  import { memberByKey } from "../users/lib/organization-people";
  import type { PresencePerson } from "../presence/lib/presence-people";
  import { PeekHover } from "./lib/peek-hover.svelte";
  import { isStackedPane, observePaneWidth } from "../../lib/pane-width";
  import { SessionLabels } from "./lib/session-labels.svelte";
  import { WorkspaceLedger } from "./lib/workspace-ledger.svelte";
  import type { WorkspaceItem, WorkspaceSessionItem, WorkspaceTab } from "./lib/workspace-items";
  import { buildWorkspaceItems, isHtmlArtifact } from "./lib/workspace-items";
  import { buildWorkspaceAppItems, type WorkspaceAppItem } from "./lib/workspace-apps";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import type { RouteParams } from "../../contexts/workspace/routing/route-registry";

  /** The route names the tab a link opens on (`/folio/apps`); the cloud console mounts the page with no route. */
  let { params }: { params?: RouteParams["folio"] } = $props();

  const session = getSurfaceContext();
  // The ledger is mounted by the workspace and by the cloud console alike
  // (docs/plans/cloud-console-native-pages.md §9). The sessions a card leads
  // back to, the split opens, the catalog's history, and the page's close
  // need a workspace.
  const workspace = session.workspace;
  const shell = getClientShellContext();

  // A console page is open for as long as it is mounted.
  const open = $derived(workspace?.router.at("folio") ?? true);

  // ── Data ──
  // The Workspace is global: every work from every project, never scoped to
  // one. Plans are session artifacts and stay with their sessions.
  // Local works and the selected organization's (organization-scope §2).
  const worksList: WorkListing[] = $derived(
    session.worksStore.visibleWorks.filter(
      (w) => session.worksStore.pendingWorkDelete?.id !== w.id,
    ),
  );
  // A work belongs to the project its host and folder name; a work outside
  // every known project still shows, under its own folder.
  const allItems: WorkspaceItem[] = $derived(
    buildWorkspaceItems(worksList, {
      keyOf: (work) => {
        const serverId = session.worksStore.hostFor(work.id);
        return serverId && work.cwd ? projectsStore.projectKeyFor(serverId, work.cwd) : work.cwd;
      },
      optionsFor: (projectKeys) => session.projectOptionsFor(projectKeys),
    }, {
      summaryOf: (workId) => session.worksStore.reviews.summaries.get(workId),
      awaitsMe: (workId) => !!session.worksStore.reviews.inboxItem(workId),
    }),
  );
  // The apps of every connected host (docs/plans/apps.md §9). A project is
  // named as the works name it, so one Project filter serves every tab.
  $effect(() => appsStore.watch());
  const appItems: WorkspaceAppItem[] = $derived(
    buildWorkspaceAppItems(appsStore.rows, {
      hostLabel: (serverId) => hostLabelFor(serverId) ?? serverId,
      projectKeyOf: (serverId, folder) => projectsStore.projectKeyFor(serverId, folder),
      optionsFor: (projectKeys) => session.projectOptionsFor(projectKeys),
    }),
  );
  // The four groups (docs/workspace-page.md): the reader's own works, the
  // works other people shared with them, the sessions other people shared
  // with them — the ones in this person's list with a role below owner — and
  // the apps on their hosts.
  const ledger = new WorkspaceLedger({
    works: () => allItems,
    sessions: () => sessionListStore.sessionsInOrganization(serversStore.activeOrganizationId),
    apps: () => appItems,
  });
  // The Apps tab is in the route, so a link and the palette open it. The other
  // tabs are the page's own state.
  $effect(() => {
    const routed = params?.tab;
    untrack(() => {
      if (routed === "apps") ledger.tab = "apps";
      else if (ledger.tab === "apps") ledger.tab = "yours";
    });
  });
  function selectTab(next: WorkspaceTab) {
    ledger.tab = next;
    // The route changes only when the page moves to the Apps tab or away from it.
    if (workspace?.router.destination.name === "folio" && (params?.tab === "apps") !== (next === "apps")) {
      workspace.router.navigate({ name: "folio", params: next === "apps" ? { tab: "apps" } : {} }, { replace: true });
    }
  }
  const anyLoading = $derived(session.worksStore.listLoading);
  const loading = $derived(allItems.length === 0 && anyLoading);
  const backgroundLoading = $derived(!loading && anyLoading);
  const synced = syncStamp(() => anyLoading);
  function refreshRecentProjects() {
    if (!workspace) return;
    for (const host of serversStore.servers) {
      void projectsStore.loadRecentProjects(host.id);
    }
  }

  function load() {
    void session.worksStore.loadAll();
    void appsStore.loadAll();
  }

  // ── View state ──
  let searchEl: HTMLInputElement | null = $state(null);
  let scrollEl: HTMLDivElement | null = $state(null);
  let itemContextMenu = $state<{
    item: WorkspaceItem;
    x: number;
    y: number;
  } | null>(null);

  /** The hover peek — the ledger's only preview. It is deliberately not the
   *  selection: peeking must never lose your place in a 400-card ledger. */
  const peek = new PeekHover();

  // ── The stacked rung ──
  // The grid reflows in CSS, but two decisions here are not expressible as a
  // container query: whether a tap previews or opens, and which shell the
  // peek takes — the peek is portalled to the body, so no container query
  // reaches it. Both read the page's own box, at the same 30rem the
  // stylesheet uses, so the layout and the behaviour cannot disagree.
  let rootEl = $state<HTMLDivElement | null>(null);
  let paneWidth = $state(0);
  $effect(() => {
    if (!rootEl) return;
    return observePaneWidth(rootEl, (width) => (paneWidth = width));
  });
  const stacked = $derived(isStackedPane(paneWidth));
  /** Names for the sessions the cards link back to. */
  const sessionLabels = new SessionLabels();

  $effect(() => {
    if (!open) return;
    untrack(() => {
      refreshRecentProjects();
      ledger.clearFilters();
      ledger.resetSelection();
      peek.close();
      load();
      // The shared tabs name who a record came from; the organization's
      // people are read once and kept.
      if (serversStore.activeOrganizationId) void sharesStore.loadDirectory().catch(() => {});
      blurActiveTextInputOnMobile();
      if (!runtime.shouldSuppressFocus) {
        tick().then(() => searchEl?.focus());
      }
    });
  });

  $effect(() =>
    serverConnections.onReadinessChange((serverId, readiness) => {
      if (readiness !== "ready" || !open) return;
      if (workspace) void projectsStore.loadRecentProjects(serverId);
      void session.worksStore.loadAll();
    }),
  );

  // A work's share list changed on some host: its card's share line reads the
  // listing, so the listing is read again. The works themselves are unchanged.
  $effect(() =>
    subscribeAllHosts("share.changed", (_serverId, change) => {
      if (open && change.resource.kind === "work") void session.worksStore.loadAll();
    }),
  );

  // ── Selection bookkeeping ──
  $effect(() => {
    void ledger.filter.type;
    void ledger.filter.pinnedOnly;
    void ledger.filter.awaitingMyReview;
    void ledger.filter.time;
    void ledger.filter.project;
    void ledger.filter.text;
    void ledger.sort;
    void ledger.tab;
    ledger.resetSelection();
  });

  $effect(() => {
    if (ledger.selectedIndex >= ledger.walkLength && ledger.walkLength > 0) ledger.selectedIndex = 0;
  });

  $effect(() => {
    if (!open) return;
    void ledger.selectedIndex;
    void ledger.walkLength;
    void tick().then(() => {
      const el = scrollEl?.querySelector<HTMLElement>('[data-selected="true"]');
      el?.scrollIntoView({ block: "nearest" });
    });
  });

  // Only the cards that are actually rendered are looked up — the ledger pages
  // in 80 at a time, so scrolling resolves the next batch rather than the whole
  // history up front.
  /** The host that owns an artifact's origin session: the work's owner host. */
  function originServerId(item: WorkspaceItem): string | null {
    return session.worksStore.hostFor(item.id);
  }

  $effect(() => {
    sessionLabels.ensure(
      ledger.flat.map((item) => ({
        sessionId: item.sessionId,
        serverId: originServerId(item),
      })),
    );
  });

  /** "Solus Cloud" when the artifact lives on the workspace service. */
  function homeLabel(item: WorkspaceItem): string | null {
    return serversStore.cloudHomeLabel(session.worksStore.hostFor(item.id));
  }

  /** What to call the session an artifact came from. A session open in a tab
   *  knows its own name; the index answers for everything else. */
  function originLabel(item: WorkspaceItem): string | null {
    if (!item.sessionId) return null;
    return (
      (workspace && liveSessionTitle(item.sessionId, originServerId(item), workspace)) ??
      sessionLabels.get(item.sessionId)
    );
  }

  /** The card the keyboard cursor is on — what the peek anchors to when it is
   *  opened or moved from the keyboard. */
  function selectedCardEl(): HTMLElement | null {
    return scrollEl?.querySelector<HTMLElement>('[data-selected="true"]') ?? null;
  }

  // An open peek follows the cursor: the same card, new contents, no delay and
  // no second animation.
  $effect(() => {
    void ledger.selectedIndex;
    if (!untrack(() => peek.open)) return;
    void tick().then(() => {
      const item = untrack(() => ledger.selectedItem);
      if (item) peek.follow(item, selectedCardEl());
    });
  });

  // Scroll, click, or any keypress dismisses the card immediately — except the
  // keys that drive it: ⇧ pins it, and the arrows swap its contents.
  //
  // The card only. The sheet has buttons, and a tap's mousedown lands before
  // its click: dismissing here would unmount the sheet under the finger and
  // the Open, Pin and Delete clicks would fire on nothing. The sheet owns its
  // own ways out — the backdrop, Escape, and those buttons.
  $effect(() => {
    if (!peek.open || stacked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        peek.pin();
        return;
      }
      if (["ArrowDown", "ArrowUp", " ", "Escape"].includes(e.key)) return;
      peek.close();
    };
    const onPointer = () => peek.close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
    };
  });

  function handleLedgerScroll() {
    // The card again, not the sheet: the sheet's backdrop covers the ledger,
    // so the only scroll that reaches here while it is up is the ledger's own
    // scroll-into-view of the card just tapped — which must not dismiss it.
    if (!stacked) peek.close();
    const el = scrollEl;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) ledger.renderMore();
  }

  // ── Keyboard ──
  useScope("workspace", { active: () => open });
  // Escape closes the peek before it closes the page — dismissing what is on
  // top is what Escape means here.
  useKeybinding(
    "workspace.close",
    () => {
      if (peek.open) peek.close();
      else close();
    },
    { enabled: () => open },
  );
  useKeybinding(
    "workspace.peek",
    () => {
      const card = selectedCardEl();
      if (ledger.selectedItem && card) peek.toggle(ledger.selectedItem, card);
    },
    { enabled: () => open && ledger.flat.length > 0 },
  );
  useKeybinding("workspace.focus-search", () => searchEl?.focus(), {
    enabled: () => open && document.activeElement !== searchEl,
  });
  useKeybinding(
    "workspace.open",
    () => {
      if (ledger.selectedItem) void openItem(ledger.selectedItem);
      else if (ledger.selectedSession) void openSharedSession(ledger.selectedSession);
      else if (ledger.selectedApp) openApp(ledger.selectedApp);
    },
    { enabled: () => open && ledger.walkLength > 0 },
  );
  useKeybinding(
    "workspace.resume",
    () => {
      if (ledger.selectedItem) void resumeItem(ledger.selectedItem);
    },
    { enabled: () => open && ledger.flat.length > 0 },
  );
  useKeybinding("workspace.next", () => ledger.selectNext(), { enabled: () => open && ledger.walkLength > 0 });
  useKeybinding("workspace.prev", () => ledger.selectPrevious(), { enabled: () => open && ledger.walkLength > 0 });
  useKeybinding(
    "workspace.toggle-pin",
    () => {
      if (ledger.selectedItem) togglePin(ledger.selectedItem);
    },
    { enabled: () => open && ledger.flat.length > 0 },
  );
  useKeybinding("workspace.tab-yours", () => selectTab("yours"), { enabled: () => open });
  useKeybinding("workspace.tab-shared-works", () => selectTab("shared-works"), { enabled: () => open });
  useKeybinding("workspace.tab-shared-sessions", () => selectTab("shared-sessions"), { enabled: () => open });
  useKeybinding("workspace.tab-apps", () => selectTab("apps"), { enabled: () => open });

  // ── Actions ──
  function close() {
    workspace?.router.close("folio");
  }

  async function openItem(item: WorkspaceItem) {
    if (workspace) await workspace.openWorkModal(item.id);
    else session.openWork(item.id);
  }

  async function openItemInSplit(item: WorkspaceItem) {
    if (!workspace) return;
    await workspace.openWorkModal(item.id);
  }

  async function resumeItem(item: WorkspaceItem) {
    if (!workspace) return;
    const work = item.work;
    if (work.sessionIds?.length || work.sessionId) {
      await workspace.openChatForWork(item.id, "resume");
    }
  }

  /** The origin session beside the ledger rather than in place of it. Resuming
   *  in the background hands back the tab without stealing the pane, so the
   *  Workspace stays put and the conversation opens as its companion. */
  async function openSessionInSplit(item: WorkspaceItem) {
    if (!item.sessionId || !workspace) return;
    const work = item.work;
    let tabId: string;
    try {
      tabId = await workspace.opening.resumeSession(
        {
          serverId: session.worksStore.hostFor(work.id) ?? undefined,
          provider: work.agentProvider ?? session.settings.activeAgent,
          sessionId: item.sessionId,
          slug: null,
          firstMessage: item.title,
          lastTimestamp: new Date(item.timestamp).toISOString(),
          size: 0,
          cwd: item.cwd,
          projectPath: "",
        },
        { background: true },
      );
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error;
      workspace.notifySessionUnavailable(work.agentProvider);
      return;
    }
    const resumed = tabId ? workspace.sessionFor(tabId) : undefined;
    if (resumed) workspace.openChatSurface(resumed.id);
  }

  /** A shared session opens where it runs, as a tab; the console shows its record. */
  async function openSharedSession(item: WorkspaceSessionItem) {
    if (!workspace) {
      shell.openResource({ kind: "session", sessionId: item.sessionId, serverId: item.serverId });
      return;
    }
    const { provider, cwd, projectPath } = item.listed.opensWith;
    try {
      await workspace.opening.resumeSession({
        serverId: item.serverId,
        provider,
        sessionId: item.sessionId,
        slug: null,
        firstMessage: item.title,
        lastTimestamp: new Date(item.timestamp).toISOString(),
        size: 0,
        cwd,
        projectPath,
      });
    } catch (error) {
      if (!(error instanceof SessionUnavailableError)) throw error;
      workspace.notifySessionUnavailable(provider);
    }
  }

  /** An app opens as the destination, in place of the page. */
  function openApp(item: WorkspaceAppItem) {
    workspace?.openApp(item.serverId, item.slug, "leading");
  }

  function togglePin(item: WorkspaceItem) {
    void session.worksStore.setPinned(item.id, !item.pinned);
  }

  /** The Share dialog pushes a Local work into the window's organization (docs/plans/host-sharing.md §2); signed out, the item says to sign in. */
  function canShare(item: WorkspaceItem): boolean {
    const serverId = session.worksStore.hostFor(item.id);
    return !!serverId && (!accountStore.isSignedIn || sharesStore.canShareFrom(serverId, "work"));
  }
  function shareItem(item: WorkspaceItem) {
    const serverId = session.worksStore.hostFor(item.id);
    if (serverId) void sharesStore.open({ serverId, resource: { kind: "work", id: item.id }, title: item.title });
  }

  /** Who has the work open now, from its host's room. */
  function workPresence(workId: string): PresencePerson[] {
    const serverId = session.worksStore.hostFor(workId);
    return serverId ? presenceStore.peopleFocusedOn(serverId, { kind: "work", workId }) : [];
  }

  /** Who is in a shared session now, from its host's room. */
  function sessionPresence(item: WorkspaceSessionItem): PresencePerson[] {
    return presenceStore.peopleFocusedOn(item.serverId, { kind: "session", sessionId: item.sessionId });
  }

  /** Everyone present in the records a tab holds, each person once: the
   *  strip shows a shared tab's activity before the reader opens it. */
  function presentIn(which: WorkspaceTab): PresencePerson[] {
    const people = which === "shared-works"
      ? ledger.ownership.shared.flatMap((item) => workPresence(item.id))
      : which === "shared-sessions"
        ? ledger.sharedSessionItems.flatMap(sessionPresence)
        : [];
    const seen = new Set<string>();
    return people.filter((person) => !seen.has(person.userId) && seen.add(person.userId));
  }

  /** The person a shared record belongs to, when the organization's directory names them. */
  function ownerOf(ownerKey: string) {
    return memberByKey(sharesStore.directory, ownerKey) ?? null;
  }

  function hostLabelFor(serverId: string): string | null {
    return serversStore.servers.find((server) => server.id === serverId)?.label ?? null;
  }

  function deleteItem(item: WorkspaceItem) {
    session.requestWorkDelete(item.work);
    void tick().then(() => searchEl?.focus());
  }

  function openItemContextMenu(event: MouseEvent, item: WorkspaceItem) {
    event.preventDefault();
    event.stopPropagation();
    peek.close();
    const index = ledger.flat.indexOf(item);
    if (index >= 0) ledger.selectedIndex = index;
    itemContextMenu = { item, x: event.clientX, y: event.clientY };
  }

  function createNew(type: "doc") {
    void session.createBlankWork(type);
  }

  let importInput: HTMLInputElement | null = $state(null);
  /** Paste-a-link import of a Confluence page or Google Doc. */
  let importDocOpen = $state(false);
  /** The provider the user picked in "Import from", or undefined when the
   *  dialog was opened without naming one. */
  let importDocProvider = $state<DocProviderId | undefined>(undefined);

  function openImportDialog(provider: DocProviderId) {
    importDocProvider = provider;
    importDocOpen = true;
  }

  /** A provider the user could sign in to is a route, not a dead end: the
   *  workspace's provider settings, or the console's connections page. */
  function openProviderSettings() {
    if (workspace) workspace.showSettings("integrations");
    else shell.openResource({ kind: "connections" });
  }

  async function onImportFile(e: Event) {
    if (!(e.target instanceof HTMLInputElement)) return;
    const input = e.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const text = await file.text();
    const title =
      file.name.replace(/\.(md|markdown|txt)$/i, "") || "Imported document";
    await session.createWorkFromContent(title, "doc", text);
  }
</script>

{#snippet newMenu(triggerClass: string, iconSize: number)}
  <WorkspaceNewMenu
    {triggerClass}
    {iconSize}
    onCreate={createNew}
    onImportFile={() => importInput?.click()}
    onImportFrom={openImportDialog}
    onOpenProviderSettings={openProviderSettings}
    loadDocProviders={() => session.worksStore.loadDocProviders()}
  />
{/snippet}

{#snippet tabStrip()}
  <WorkspaceTabStrip tabs={ledger.tabSpecs} tab={ledger.tab} onSelect={selectTab} {presentIn} />
{/snippet}

{#snippet workCard(item: WorkspaceItem, index: number)}
  <WorkspaceCard
    {item}
    selected={index === ledger.selectedIndex}
    showProject={ledger.showProject}
    homeLabel={homeLabel(item)}
    query={ledger.filter.text}
    onOpen={() => {
      ledger.selectedIndex = index;
      return stacked && !isHtmlArtifact(item) ? peek.raise(item) : openItem(item);
    }}
    onTogglePin={() => togglePin(item)}
    onDelete={ledger.tab === "yours" ? () => deleteItem(item) : undefined}
    sessionLabel={originLabel(item)}
    onOpenSession={workspace && item.sessionId ? () => resumeItem(item) : undefined}
    onOpenSessionSplit={workspace && item.sessionId ? () => openSessionInSplit(item) : undefined}
    onPeek={(card) => peek.enter(item, card)}
    onPeekLeave={() => peek.leave()}
    onContextMenu={(event) => openItemContextMenu(event, item)}
    present={workPresence(item.id)}
    sharedBy={item.ownerKey ? (ownerOf(item.ownerKey)?.displayName ?? null) : null}
  />
{/snippet}

{#snippet sessionCard(item: WorkspaceSessionItem, index: number)}
  <WorkspaceSessionCard
    {item}
    selected={index === ledger.selectedIndex}
    query={ledger.filter.text}
    hostLabel={hostLabelFor(item.serverId)}
    owner={ownerOf(item.ownerKey)}
    present={sessionPresence(item)}
    onOpen={() => {
      ledger.selectedIndex = index;
      return openSharedSession(item);
    }}
  />
{/snippet}

<!-- A quiet sentence-case label and its count, 30px tall. Each pins to the
     top of the scroll area on an opaque background, so the current bucket is
     always named, even 300 cards down. -->
{#snippet groupHeader(label: string, count: number)}
  <span class="text-[13px] font-medium text-foreground/80">{label}</span>
  <span class="text-xs tabular-nums text-muted-foreground">{count}</span>
  <span class="flex-1"></span>
{/snippet}

{#if open}
  <div
    bind:this={rootEl}
    class="workspace-root relative flex min-h-0 flex-1 flex-col bg-background text-workspace-chrome text-foreground"
    role="dialog"
    aria-label="Workspace"
    tabindex="-1"
  >
    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        {#if stacked}
          <!-- ── The record head ──
               A phone has no crumb line: the drawer control is the way back to
               everything else, the page names itself, and the counts the wide
               head spends a sync chip on are stated as the fact they are. -->
          <div class="flex h-[60px] shrink-0 items-center gap-1.5 px-2.5">
            {#if frameChrome.openNavigationDrawer}
              <button
                type="button"
                class="relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-foreground active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
                onclick={frameChrome.openNavigationDrawer}
                aria-label="Open navigation"
              >
                <SidebarSimpleIcon size={19} />
                {#if frameChrome.navigationHasUnseen}
                  <span
                    class="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-primary shadow-[0_0_0_2px_var(--background)]"
                    aria-hidden="true"
                  ></span>
                {/if}
              </button>
            {/if}
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-base/[1.15] font-semibold tracking-[-0.016em]">Workspace</span>
              <span class="flex items-center gap-[7px] text-xs text-muted-foreground">
                <span class="font-medium text-foreground"
                  >{ledger.allItems.length}
                  {ledger.allItems.length === 1 ? "artifact" : "artifacts"}</span
                >
                <span class="opacity-35" aria-hidden="true">·</span>
                <span>{ledger.sharedSessionItems.length} shared {ledger.sharedSessionItems.length === 1 ? "session" : "sessions"}</span>
              </span>
            </span>
            {@render newMenu(
              "flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-primary px-[13px] font-semibold text-primary-foreground [-webkit-tap-highlight-color:transparent]",
              16,
            )}
          </div>

          <div class="shrink-0 px-4">
            {@render tabStrip()}
          </div>

          <div class="flex min-w-0 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-4 pt-2 pb-2.5 text-workspace-chrome">
            <WorkspaceSearchField filter={ledger.filter} totalCount={ledger.tabTotal} itemNoun={ledger.tab === "apps" ? "apps" : undefined} scopeLabel={ledger.scopeLabel} matches={ledger.searching ? ledger.walkLength : null} bind:ref={searchEl} />
            <WorkspaceFilterControls {ledger} />
          </div>
        {:else}
          <!-- ── Row 1: the page title, and the controls that act on the
               window. It keeps one fixed top measure when the session sidebar
               opens or closes. ── -->
          <div
            class="workspace-titlebar mx-auto flex w-full max-w-[72rem] shrink-0 items-center px-8 pt-[42px] pb-[13px] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
          >
            <PageCrumbLine
              page="folio"
              onRefresh={load}
              refreshing={anyLoading}
              syncedAt={synced.at}
              onClose={workspace ? close : undefined}
            />
          </div>

          <!-- ── Row 2: the four groups ── -->
          <div
            class="mx-auto w-full max-w-[72rem] shrink-0 px-8 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
          >
            {@render tabStrip()}
          </div>

          <!-- ── Row 3: search · sort · filters · New ── -->
          <div
            class="mx-auto flex w-full max-w-[72rem] shrink-0 flex-wrap items-center gap-2 px-8 pt-2.5 pb-[14px] text-workspace-chrome @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[34rem]:px-4"
          >
          <WorkspaceSearchField
            filter={ledger.filter}
            totalCount={ledger.tabTotal}
            itemNoun={ledger.tab === "apps" ? "apps" : undefined}
            scopeLabel={ledger.scopeLabel}
            matches={ledger.searching ? ledger.walkLength : null}
            bind:ref={searchEl}
          />
          <WorkspaceFilterControls {ledger} />

          <span
            class="mx-0.5 h-[18px] w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
            aria-hidden="true"
          ></span>
          {@render newMenu(
            "flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-primary px-[13px] font-medium text-primary-foreground shadow-[0_1px_2px_rgba(24,20,16,.14)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]",
            16,
          )}
          </div>
        {/if}

        <!-- ── Ledger ── -->
        <div
          bind:this={scrollEl}
          class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-5 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 mx-auto w-full max-w-[72rem] @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] px-8 @max-[44rem]:px-5 @max-[34rem]:px-4"
          role="listbox"
          aria-label="Workspace items"
          tabindex="-1"
          onscroll={handleLedgerScroll}
        >
          {#if ledger.tab === "apps"}
            <WorkspaceAppsTab {ledger} onOpen={openApp} />
          {:else if loading}
            <div class="grid grid-cols-3 gap-3 pt-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1" aria-hidden="true">
              {#each Array(6) as _, i (i)}
                <div class="h-[108px] animate-pulse rounded-xl bg-[var(--wash-2)]" style="opacity:{1 - i * 0.12}"></div>
              {/each}
            </div>
          {:else if ledger.tab === "shared-sessions"}
            {#if ledger.sharedSessionItems.length === 0}
              <PageEmpty icon={SharedSessionsIcon} title="No sessions shared with you.">
                A session another person shares with you opens here, where it runs.
              </PageEmpty>
            {:else if ledger.filteredSessions.length === 0}
              <PageEmpty title="No matches in this filter.">
                Try a different search.
                {#snippet actions()}
                  <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => ledger.clearFilters()}>Clear filters</button>
                {/snippet}
              </PageEmpty>
            {:else}
              {#each ledger.renderedSessionGroups as group (group.key)}
                {@const groupOffset = ledger.sessionOffsetOf(group)}
                <div class="sticky top-0 z-[1] mt-3 flex h-[30px] items-center gap-2 bg-background px-1">
                  {@render groupHeader(group.label, group.total)}
                </div>
                <div class="grid grid-cols-3 gap-3 pt-1 pb-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1">
                  {#each group.items as item, j (item.rowKey)}
                    {@render sessionCard(item, groupOffset + j)}
                  {/each}
                </div>
              {/each}
            {/if}
          {:else if ledger.items.length === 0}
            {#if ledger.tab === "shared-works"}
              <PageEmpty icon={SharedIcon} title="No works shared with you.">
                A doc or artifact another person shares with you lands here.
              </PageEmpty>
            {:else}
              <PageEmpty icon={BooksIcon} title="Nothing here yet.">
                Docs and artifacts from every project land here.
                {#snippet actions()}
                  <button type="button" class={PAGE_PRIMARY_BTN} onclick={() => createNew("doc")}>
                    <PlusIcon size={13} weight="bold" />
                    <span>New document</span>
                  </button>
                {/snippet}
              </PageEmpty>
            {/if}
          {:else if ledger.filtered.length === 0}
            <PageEmpty title="No matches in this filter.">
              {#if ledger.filter.text.trim() && ledger.outsideCount > 0}
                {ledger.outsideCount}
                {ledger.outsideCount === 1 ? "match" : "matches"} outside the active filters.
              {:else}
                Try a different search or filter.
              {/if}
              {#snippet actions()}
                <button type="button" class={PAGE_SECONDARY_BTN} onclick={() => ledger.clearFilters()}>Clear filters</button>
              {/snippet}
            </PageEmpty>
          {:else}
            <!-- A pinned item is *moved* here, not copied: its date group's
                 count drops accordingly and no title appears twice. -->
            {#if ledger.grouped.pinned.length > 0}
              <div class="sticky top-0 z-[1] flex h-[30px] items-center gap-2 bg-background px-1">
                <button
                  type="button"
                  class="flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-muted-foreground opacity-60 transition-transform duration-200 {ledger.pinnedCollapsed ? '' : 'rotate-90'}"
                  onclick={() => ledger.togglePinnedCollapsed()}
                  aria-label={ledger.pinnedCollapsed ? "Expand pinned" : "Collapse pinned"}
                  aria-expanded={!ledger.pinnedCollapsed}
                >
                  <CaretRightIcon size={11} />
                </button>
                {@render groupHeader("Pinned", ledger.grouped.pinned.length)}
                {#if ledger.pinnedOverflow > 0 || ledger.pinnedExpanded}
                  <button
                    type="button"
                    class="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground opacity-80 hover:text-foreground"
                    onclick={() => (ledger.pinnedExpanded = !ledger.pinnedExpanded)}
                  >
                    {ledger.pinnedExpanded ? "Show less" : "Show all"}
                  </button>
                {/if}
              </div>
              {#if ledger.pinnedShown.length > 0}
                <div class="grid grid-cols-3 gap-3 pt-1 pb-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1">
                  {#each ledger.pinnedShown as item, i (item.rowKey)}
                    {@render workCard(item, i)}
                  {/each}
                </div>
              {/if}
              {#if ledger.pinnedOverflow > 0}
                <button
                  type="button"
                  class="flex h-[30px] w-full cursor-pointer items-center gap-[9px] rounded-lg border-0 bg-transparent pr-3 pl-2.5 text-xs text-muted-foreground transition-shadow duration-150 hover:shadow-[inset_0_0_0_999px_var(--wash-1)]"
                  onclick={() => (ledger.pinnedExpanded = true)}
                >
                  <span class="flex w-4 shrink-0 justify-center opacity-60">
                    <CaretDownIcon size={11} />
                  </span>
                  {ledger.pinnedOverflow} more pinned
                </button>
              {/if}
            {/if}

            {#each ledger.renderedGroups as group (group.key)}
              {@const groupOffset = ledger.offsetOf(group)}
              <div class="sticky top-0 z-[1] mt-3 flex h-[30px] items-center gap-2 bg-background px-1">
                {@render groupHeader(group.label, group.total)}
              </div>
              <div class="grid grid-cols-3 gap-3 pt-1 pb-2 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1">
                {#each group.items as item, j (item.rowKey)}
                  {@render workCard(item, groupOffset + j)}
                {/each}
              </div>
            {/each}

            <!-- Cards still on their way in: only at the true tail of the
                 ledger, where more items would actually appear. -->
            {#if backgroundLoading && !ledger.searching && !ledger.hasMoreRows}
              <div class="grid grid-cols-3 gap-3 pt-1 @max-[48rem]/pane:grid-cols-2 @max-[30rem]/pane:grid-cols-1" aria-hidden="true">
                {#each Array(3) as _, i (i)}
                  <div class="h-[108px] animate-pulse rounded-xl bg-[var(--wash-2)]" style="opacity:{0.55 - i * 0.15}"></div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>

    </div>

    {#if itemContextMenu}
      {@const menuItem = itemContextMenu.item}
      <WorkspaceItemContextMenu
        x={itemContextMenu.x}
        y={itemContextMenu.y}
        item={menuItem}
        onOpen={() => void openItem(menuItem)}
        onOpenSplit={workspace
          ? () => void openItemInSplit(menuItem)
          : undefined}
        onTogglePin={() => togglePin(menuItem)}
        onOpenSession={workspace && menuItem.sessionId
          ? () => void resumeItem(menuItem)
          : undefined}
        onOpenSessionSplit={workspace && menuItem.sessionId
          ? () => void openSessionInSplit(menuItem)
          : undefined}
        onShare={canShare(menuItem)
          ? () => shareItem(menuItem)
          : undefined}
        onRequestReview={() => openWorkReview(session, menuItem.id)}
        onCopyReviewLink={() => void copyWorkReviewLink(session.worksStore.hostFor(menuItem.id), menuItem.id, menuItem.title)}
        onDelete={() => deleteItem(menuItem)}
        onClose={() => (itemContextMenu = null)}
      />
    {/if}

    <!-- The preview: a transient card over the row, never a reserved column.
         On a stacked pane it is the same card raised as a sheet, because there
         the tap that would have opened the artifact previews it instead — so
         the sheet is where Open actually lives. -->
    {#if peek.item && stacked}
      <WorkspacePeek
        item={peek.item}
        query={ledger.filter.text}
        pinned={peek.pinned}
        variant="sheet"
        onOpen={() => {
          const target = peek.item;
          if (!target) return;
          // Use the canonical opener. It closes Folio before it places the work,
          // so an existing artifact pane cannot leave the mobile page covering
          // the newly focused work. The preview already hydrated the work, so
          // ensureContent returns from the store without another remote read.
          void openItem(target).then(() => peek.close());
        }}
        onTogglePin={() => {
          const target = peek.item;
          if (target) togglePin(target);
        }}
        onDelete={() => {
          const target = peek.item;
          peek.close();
          if (target) deleteItem(target);
        }}
        onClose={() => peek.close()}
      />
    {:else if peek.item && peek.anchor && scrollEl}
      <WorkspacePeek
        item={peek.item}
        anchor={peek.anchor}
        ledger={scrollEl}
        query={ledger.filter.text}
        pinned={peek.pinned}
      />
    {/if}
  </div>

  <ImportDocDialog
  open={importDocOpen}
  provider={importDocProvider}
  onClose={() => {
    importDocOpen = false;
    importDocProvider = undefined;
  }}
/>

  <input
    bind:this={importInput}
    type="file"
    accept=".md,.markdown,.txt,text/markdown,text/plain"
    class="sr-only"
    onchange={onImportFile}
    tabindex="-1"
    aria-hidden="true"
  />
{/if}

<style>
  .workspace-root {
    overflow: hidden;
    /* Query container so the head and filter row respond to the pane's own
       width (a split pane or mobile web), not the viewport. */
    container: workspace-page / inline-size;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }
</style>
