<script lang="ts">
import Icon from "@iconify/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteSet } from "svelte/reactivity";
  import {
    GitPullRequest as GitPullRequestIcon,
    RefreshCw as ArrowsClockwiseIcon,
    BookOpenText as BookOpenTextIcon,
    LoaderCircle as CircleNotchIcon,
    Play as PlayIcon,
    User as UserIcon,
    TriangleAlert as WarningIcon,
    CircleAlert as WarningCircleIcon,
  } from "@lucide/svelte";
  import type { PullRequestSummary } from "@solus/contracts/providers";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import {
    getWorkspaceContext,
    getSettingsContext,
    runtime,
    getSessionSidebarStore,
    projectCatalog,
    mergeProjectOptions,
    projectRefKey,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import SortMenu from "../ui/SortMenu.svelte";
  import { Button } from "../ui/button";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import {
    InboxRow,
    ListEmpty,
    ListFilterBar,
    ListGroup,
    ListPage,
    ListRailRow,
    ListRow,
    ListSkeleton,
    ListStatusMenu,
    VirtualList,
    virtualGroupItems,
    type ListFilterSpec,
    type ListPageView,
    type ListProjectOption,
    type ListStatusOption,
  } from "../ui/list-page";
  import { filterPrs, sortPrs, type PrSortMode } from "./lib/pr-utils";
  import {
    PR_STATUS_OPTIONS,
    OPEN_PR_STATUS_KEYS,
    prFetchScope,
    prGroups,
    prInboxGroups,
    prStatusOf,
    type PrRowContext,
  } from "./lib/prs-list-view";
  import type { PrReviewTab } from "../../contexts/prs/prs.store.svelte";
  import type { PrInboxProject } from "../../contexts/prs/pr-inbox.store.svelte";
  import { groupStackedPrRows } from "./lib/stack-grouping";
  import {
    flattenQualifiedProjects,
    qualifiedKeyOf,
    qualifiedStackParentOf,
    type PrTarget,
    type QualifiedProject,
  } from "./lib/pr-cross-project";
  import GithubConnectionRequired from "./GithubConnectionRequired.svelte";
  import {
    prInboxFailure,
    type PrInboxFailure,
  } from "./lib/pr-inbox-failure";
  import PrDetailPanel from "./PrDetailPanel.svelte";
  import PrContextMenu from "./PrContextMenu.svelte";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);
  const settings = getSettingsContext();
  const sessionSidebar = getSessionSidebarStore();
  const store = session.prsStore;
  const inbox = session.prInboxStore;
  const stacks = session.stacksStore;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const open = $derived(session.router.at("prs"));

  // ── List state ──
  // Everything that describes *how the list was left* lives in the store, not
  // here: opening a pull request replaces this page, so these locals would be
  // destroyed on every open and the list would forget the review it just
  // returned from. `view` is the exception — which tab of the page you are on
  // is a property of the visit, not of the reading position.
  let view = $state<ListPageView>("global");
  const listView = $derived(store.listView);
  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  let stacksReady = $state(false);
  let viewerLogin = $state("");
  let prContextMenu = $state<{
    pr: PullRequestSummary;
    x: number;
    y: number;
  } | null>(null);

  // Tick the clock so relative row times age instead of freezing at load.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  // ── Review multi-select ──
  // Checked PRs narrow the Review action: with any checked, the header button
  // opens Review Mode over just those instead of every filtered PR. Keyed by
  // the row's qualified key (not a bare number) — All projects can hold the
  // same PR number from two different repos.
  const reviewSelection = new SvelteSet<string>();

  // ── Project scope ──
  // `null` (the default) is All projects: the workspace-wide inbox, aggregated
  // in the renderer across every project the catalog and the sidebar know
  // about. A specific option pins the list to one project — the only case
  // that still drives the single-project `PrsStore` directly.
  let scopedProjectKey = $state<string | null>(null);

  // The sidebar's live projects are all on whichever host is selected there;
  // the catalog spans every host the client has ever recorded a project on.
  const sidebarServerId = $derived(serverConnections.defaultServerId());
  const projectOptions = $derived<ListProjectOption[]>(
    mergeProjectOptions(
      [
        // With no default host there is nothing to attribute a sidebar project
        // to; the catalog still carries its own host per entry.
        sidebarServerId
          ? sessionSidebar.projectSummaries
              .filter((project) => project.projectKey !== "~")
              .map((project) => ({
                serverId: sidebarServerId,
                projectRoot: project.projectKey,
                label: project.label,
              }))
          : [],
        projectCatalog.entries,
      ],
      (serverId) => serversStore.statusFor(serverId) !== "offline",
      (serverId) => serversStore.hostFor(serverId)?.label ?? serverId,
    ).map((option) => ({
      key: option.key,
      projectKey: option.projectRoot,
      serverId: option.serverId,
      label: option.label,
      available: option.available,
      historyOnly: !sessionSidebar.projectSummaries.some(
        (project) => project.projectKey === option.projectRoot,
      ),
    })),
  );
  const scopedProject = $derived(
    scopedProjectKey
      ? (projectOptions.find((option) => option.key === scopedProjectKey) ?? null)
      : null,
  );
  const isAllProjects = $derived(scopedProject === null);

  // Meaningful only when one project is scoped — All projects reads through
  // `inbox` (the aggregator) instead, one `(api, serverId, ctx)` per project.
  // Null when nothing is connected to read from: a host is a precondition for
  // loading, not something to assume, so every caller below guards rather than
  // letting `primaryApi()` throw.
  const prsServerId = $derived(
    scopedProject?.serverId ?? serverConnections.defaultServerId(),
  );
  const prsApi = $derived(
    prsServerId ? serverConnections.apiFor(prsServerId) : null,
  );
  function prsCtx(): IpcContext {
    return scopedProject
      ? session.ctxForDirectory(scopedProject.projectKey)
      : session.ctx;
  }

  // ── All projects: the aggregate read ──
  // Only projects on a host that is connected right now. A saved host that has
  // never dialed keeps its request queued in the transport with nothing to age
  // it out, and one of those inside the inbox's bounded worker pool blocks
  // every project behind it — which is how All projects ends up waiting on a
  // machine that is not there while the project you can actually read sits
  // unfetched. The picker still offers every project; only the fan-out is
  // narrowed, and the effect below re-runs as hosts connect.
  const inboxProjects = $derived<PrInboxProject[]>(
    projectOptions
      .filter((option) => serversStore.statusFor(option.serverId) === "online")
      .map((option) => ({
        serverId: option.serverId,
        projectRoot: option.projectKey,
        label: option.label,
        api: serverConnections.apiFor(option.serverId),
        ctx: session.ctxForDirectory(option.projectKey),
      })),
  );
  const qualifiedProjects = $derived<QualifiedProject[]>(
    inbox.projects.map((project) => ({
      serverId: project.serverId,
      projectRoot: project.projectRoot,
      label: project.label,
      api: project.api,
      ctx: project.ctx,
      items: project.items,
    })),
  );
  const qualified = $derived(flattenQualifiedProjects(qualifiedProjects));
  const aggregateKeyFor = $derived(qualifiedKeyOf(qualified.byPr));
  const aggregateStackParentOf = $derived(qualifiedStackParentOf(stacks, qualified.byPr));
  const inboxHasMore = $derived(inbox.projects.some((project) => project.hasMore));
  const inboxLoadingMore = $derived(inbox.projects.some((project) => project.loading && project.loadedAt > 0));
  const activeRefreshing = $derived(isAllProjects ? inbox.loading : store.loading);

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "updated", label: "Updated" },
    { value: "created", label: "Created" },
    { value: "effort", label: "Effort" },
  ];

  // The statuses the list and the inbox are showing, and the fetch scope they
  // imply — merged and closed pull requests are a separate page on the host, so
  // asking for them has to widen the load before anything can be filtered.
  const statuses = $derived(new Set(listView.statusKeys));
  const fetchScope = $derived(prFetchScope(listView.statusKeys));
  // The item list this visit is reading: one project's cache, or every
  // project's last-safe snapshot merged together.
  const activeItems = $derived(isAllProjects ? qualified.items : store.items);
  // A host that is still dialing is not an empty inbox: until it settles the
  // page is still on its way, so the skeleton holds rather than the list
  // claiming there is nothing to read.
  const inboxHostsConnecting = $derived(
    projectOptions.some(
      (option) => serversStore.statusFor(option.serverId) === "connecting",
    ),
  );
  const activeLoading = $derived(
    isAllProjects
      ? (inbox.loading || inboxHostsConnecting) && activeItems.length === 0
      : store.loading,
  );
  const openCount = $derived(
    activeItems.filter((pr) => pr.state === "open").length,
  );
  // A failed project keeps its last-safe rows, so a failure is only visible if
  // it is said out loud: a banner when something did load, the page's own
  // surface when nothing did.
  const inboxFailure = $derived(
    isAllProjects
      ? prInboxFailure(inbox.projects, activeItems.length > 0)
      : ({ kind: "none", placement: "none" } satisfies PrInboxFailure),
  );

  // ── The shared row grammar's view of a PR ──
  // `isMine` needs the connected viewer's login; until `loadViewer` lands it
  // falls back to "nobody is me", which under-fills the Yours filter rather than
  // mislabelling someone else's PR as yours. `checks` resolves through the PR's
  // own project in All projects — a bare PR number cannot tell two repos apart.
  const rowContext = $derived<PrRowContext>({
    checks: (pr) => {
      if (!isAllProjects) {
        return prsServerId ? store.checksFor(prsServerId, prsCtx(), pr.number) : undefined;
      }
      const owner = qualified.byPr.get(pr);
      return owner ? store.checksFor(owner.serverId, owner.ctx, pr.number) : undefined;
    },
    isMine: (pr) => !!viewerLogin && pr.author === viewerLogin,
  });

  const searched = $derived(
    sortPrs(
      filterPrs(
        store.needsReviewOnly
          ? activeItems.filter((pr) => pr.needsMyReview)
          : activeItems,
        listView.query,
        fetchScope,
      ),
      listView.sortMode,
    ),
  );

  const filtered = $derived.by(() => {
    let rows = searched.filter((pr) => statuses.has(prStatusOf(pr)));
    if (listView.minesOnly) rows = rows.filter((pr) => rowContext.isMine(pr));
    if (listView.failingOnly) {
      rows = rows.filter((pr) => {
        const checks = rowContext.checks(pr);
        return (
          !!checks &&
          checks.headSha === pr.headSha &&
          checks.state === "failing"
        );
      });
    }
    return rows;
  });

  // Stacks never cross a repository. In All projects each PR's stack parent
  // comes from its own project's graph (`aggregateStackParentOf`); scoped to
  // one project, it is that project's single graph as before.
  const stackGraph = $derived(
    !isAllProjects && scopedProject && settings.stackedPrsEnabled && stacksReady && prsServerId
      ? stacks.graphFor(prsServerId, scopedProject.projectKey)
      : null,
  );
  const groupedRows = $derived(groupStackedPrRows(filtered, stackGraph));
  // The row says what it is stacked on inside its own hover reveal, so the
  // relationship reads without the list having to indent anything.
  const stackParents = $derived(
    new Map(
      groupedRows
        .flatMap((row) => row.parent === null ? [] : [[row.pr.number, row.parent] as const]),
    ),
  );
  const stackParentOf = $derived(
    isAllProjects ? aggregateStackParentOf : (pr: PullRequestSummary) => stackParents.get(pr.number) ?? null,
  );
  const rowKeyOf = $derived(isAllProjects ? aggregateKeyFor : undefined);

  const groups = $derived(prGroups(filtered, rowContext, now, stackParentOf, rowKeyOf));
  // The row's verb picks the tab it lands on: a row that says Review opens on
  // the diff, everything else on Activity.
  const inboxGroups = $derived(
    prInboxGroups(activeItems, rowContext, now, {
      review: (pr) => selectPr(pr, "diff"),
      open: (pr) => selectPr(pr),
      openExternal: openPrExternal,
    }, statuses, rowKeyOf),
  );
  const inboxVirtualItems = $derived(
    virtualGroupItems(
      inboxGroups,
      (row) => row.key,
      (group) => !listView.collapsedGroups[`inbox:${group.key}`],
    ),
  );
  const globalVirtualItems = $derived(
    virtualGroupItems(
      groups,
      (row) => row.key,
      (group) => !listView.collapsedGroups[group.key],
    ),
  );
  const inboxActiveKey = $derived(
    inboxVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const globalActiveKey = $derived(
    globalVirtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );
  const unreadCount = $derived(
    inboxGroups.find((g) => g.key === "needs")?.rows.length ?? 0,
  );

  // Counts are the first thing to go at rail width: they are a nice-to-know
  // beside a label that has to survive, and the list under the chip answers the
  // same question.
  const listFilters = $derived<ListFilterSpec[]>([
    {
      key: "mine",
      label: "Yours",
      icon: UserIcon,
      count: splitList
        ? undefined
        : searched.filter((pr) => rowContext.isMine(pr)).length,
      active: listView.minesOnly,
      toggle: () => (listView.minesOnly = !listView.minesOnly),
    },
    {
      key: "failing",
      label: "Checks failing",
      icon: WarningIcon,
      count: splitList
        ? undefined
        : searched.filter((pr) => {
            const checks = rowContext.checks(pr);
            return (
              !!checks &&
              checks.headSha === pr.headSha &&
              checks.state === "failing"
            );
          }).length,
      active: listView.failingOnly,
      toggle: () => (listView.failingOnly = !listView.failingOnly),
    },
  ]);

  // The rail's filter row fits the search field and the two toggles, so the
  // menu-backed controls step aside — except when the status menu is actually
  // narrowing the list, which must never be hidden with no way to see or undo it.
  const statusFilterNarrowed = $derived(
    listView.statusKeys.length !== OPEN_PR_STATUS_KEYS.length ||
      OPEN_PR_STATUS_KEYS.some((key) => !listView.statusKeys.includes(key)),
  );

  // A status the page has not fetched can't be counted, so its count reads 0
  // until it is picked and the widened fetch lands. Better than a blank, and it
  // corrects itself the moment the answer exists.
  const statusOptions = $derived<ListStatusOption[]>(
    PR_STATUS_OPTIONS.map((option) => ({
      ...option,
      count: searched.filter((pr) => prStatusOf(pr) === option.value).length,
    })),
  );

  // The lead statistic is the reason to be on this page — how much is waiting on
  // you — and it is the only coloured text in the header.
  const summary = $derived.by(() => {
    const awaiting = activeItems.filter(
      (pr) =>
        pr.state === "open" &&
        !pr.draft &&
        pr.needsMyReview &&
        !rowContext.isMine(pr),
    ).length;
    const totalOpen = openCount;
    const mergedRecently = activeItems.filter(
      (pr) =>
        pr.state === "merged" &&
        now - (Date.parse(pr.updatedAt) || 0) < 30 * 24 * 60 * 60 * 1000,
    ).length;
    return [
      { label: `${awaiting} awaiting your review`, tint: "warning" as const },
      { label: `${totalOpen} open` },
      { label: `${mergedRecently} merged this month` },
    ];
  });

  const listNavigationItems = $derived(groupedRows.map((row) => row.pr));
  // Every row's identity, list-wide — unique across projects in All projects.
  const keyOf = $derived((pr: PullRequestSummary) => rowKeyOf?.(pr) ?? String(pr.number));

  // Publish the visible order so the review's crumb switcher and its `n of N`
  // stepper walk exactly these rows, in exactly this order. Written from the
  // page because this is where the filters and the stack grouping resolve.
  // Meaningful for the single-project stepper only — All projects keeps its
  // own local selection below, since `store.listOrder` is bare PR numbers.
  $effect(() => {
    if (isAllProjects) return;
    const order = listNavigationItems.map((pr) => pr.number);
    untrack(() => (store.listOrder = order));
  });

  // All projects keeps its own reading position: `PrsStore.listView` is reset
  // only on a *project* scope change and is keyed by bare number, which two
  // repos' identical PR numbers cannot share safely.
  let aggregateSelectedKey = $state<string | null>(null);
  let aggregateOpenKey = $state<string | null>(null);

  const selectedKey = $derived(
    isAllProjects
      ? aggregateSelectedKey
      : (listView.selectedNumber !== null ? String(listView.selectedNumber) : null),
  );
  const openKey = $derived(
    isAllProjects
      ? aggregateOpenKey
      : (listView.openNumber !== null ? String(listView.openNumber) : null),
  );

  function prByKey(key: string): PullRequestSummary | undefined {
    return isAllProjects
      ? qualified.byKey.get(key)?.pr
      : store.items.find((pr) => String(pr.number) === key);
  }

  /** Which `(api, serverId, ctx)` a row's actions route through — the page's
   *  single scope, or that row's own project in All projects. Null when no
   *  host is connected to route to, so callers skip rather than throw. */
  function targetFor(pr: PullRequestSummary): PrTarget | null {
    const owner = isAllProjects ? qualified.byPr.get(pr) : undefined;
    if (owner) return { api: owner.api, serverId: owner.serverId, ctx: owner.ctx }
    if (!prsApi || !prsServerId) return null;
    return { api: prsApi, serverId: prsServerId, ctx: prsCtx() };
  }

  const selectedPr = $derived(selectedKey ? (prByKey(selectedKey) ?? null) : null);

  // ── The detail panel ──
  // A pull request comes out from the side of the list rather than replacing it:
  // the rows stay on screen so the queue is still readable while one item is
  // being reviewed. Below the width where both fit, the panel covers the list
  // instead — a 380px column beside a 380px review is neither.
  const panelOpen = $derived(openKey !== null);
  const openPr = $derived(openKey ? (prByKey(openKey) ?? null) : null);
  const openTarget = $derived(openPr ? targetFor(openPr) : null);
  const roomForSplit = $derived(pageWidth >= 1040);
  const panelFullScreen = $derived(
    panelOpen && (listView.panelFullScreen || !roomForSplit),
  );
  const splitList = $derived(panelOpen && !panelFullScreen);

  function closePanel() {
    clearPanelState();
    void tick().then(() => {
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  function clearPanelState() {
    if (isAllProjects) aggregateOpenKey = null;
    else listView.openNumber = null;
    listView.panelFullScreen = false;
  }

  function toggleFullScreen() {
    listView.panelFullScreen = !listView.panelFullScreen;
  }

  /** Step to the pull request before or after the open one, in the list's own
   *  order — what J / K and the panel's stepper walk. */
  function stepPanel(delta: number) {
    if (listNavigationItems.length === 0 || openKey === null) return;
    const index = listNavigationItems.findIndex((p) => keyOf(p) === openKey);
    if (index === -1) return;
    const next =
      listNavigationItems[
        (index + delta + listNavigationItems.length) % listNavigationItems.length
      ];
    // Stepping is a move inside one reading session, so it keeps the tab you
    // are reading; only picking a row afresh re-decides that.
    if (next && keyOf(next) !== openKey) selectPr(next, store.prReviewTab);
  }

  function prUrl(pr: PullRequestSummary): string | null {
    const repo = pr.baseRepo;
    return repo
      ? `https://${repo.host}/${repo.owner}/${repo.repo}/pull/${pr.number}`
      : null;
  }

  function openPrExternal(pr: PullRequestSummary) {
    const url = prUrl(pr);
    if (url) void localApi.openExternal(url);
  }

  function openPrRoute(pr: PullRequestSummary, target: PrTarget) {
    clearPanelState();
    void session.enterPrReview(pr.number, pr.title, {
      ctx: target.ctx,
      serverId: target.serverId,
      target: paneId,
      via: "click",
    });
  }

  function openPrContextMenu(event: MouseEvent, pr: PullRequestSummary) {
    event.preventDefault();
    event.stopPropagation();
    if (isAllProjects) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
    prContextMenu = { pr, x: event.clientX, y: event.clientY };
  }

  // ── Data loading ──

  // Opening the page and explicitly targeting a project are the only triggers
  // this effect should react to. `session.ctx` reads reactive git state
  // (gitContext, changedFiles) that the git watcher churns on every on-disk
  // change, so tracking it here would re-fire loadAll (flipping `loading` back
  // on) and wipe the user's selection. Untrack the body so normal git updates
  // cannot reset the page.
  //
  // The view state is NOT reset here. Opening a pull request replaces this
  // page, so every return from a review re-runs this effect — resetting would
  // throw away the scroll position, group collapse and selection the design
  // requires to survive the round trip. Only a change of project scope
  // (`selectProject`) forgets them.
  $effect(() => {
    // The route names a bare path (other callers — the `prReview` exit route,
    // the command palette — know nothing about qualified keys); resolve it
    // against the current host, same as every other bare-path caller always
    // implicitly meant "on the host I'm looking at".
    const requestedProjectPath =
      session.router.params("prs")?.projectPath ?? null;
    if (!open) return;
    untrack(() => {
      scopedProjectKey = requestedProjectPath && sidebarServerId
        ? projectRefKey({ serverId: sidebarServerId, projectRoot: requestedProjectPath })
        : null;
      void loadActiveScope();
      restoreReadingPosition();
    });
  });

  /** Loads the one scoped project through `PrsStore`. All projects reads
   *  through the inbox effect below instead, which follows the hosts that can
   *  answer rather than the ones that happened to be up at page open. */
  async function loadActiveScope(): Promise<void> {
    if (isAllProjects) return;
    // No connected host is a real state, not an error: nothing loads, and
    // the page shows its empty surface rather than throwing on `apiFor`.
    const api = prsApi;
    const serverId = prsServerId;
    if (!api || !serverId) return;
    store.filter = { state: fetchScope };
    void store.loadAll(api, serverId, prsCtx());
    void store
      .loadViewer(api, serverId, prsCtx())
      .then((login) => (viewerLogin = login))
      .catch(() => {});
    stacksReady = false;
    void stacks.load(api, serverId, prsCtx()).then(
      () => (stacksReady = true),
      () => (stacksReady = false),
    );
  }

  // Which hosts are connected changes while the page is open — one finishes
  // dialing, another drops — so the aggregate read is keyed on that set rather
  // than fired once. The body is untracked because `inboxProjects` also carries
  // live git context that the watcher churns on every on-disk change; tracking
  // that would flip the list back to loading under the reader.
  const reachableInboxKey = $derived(
    inboxProjects
      .map((project) => `${project.serverId} ${project.projectRoot}`)
      .join("\n"),
  );

  $effect(() => {
    if (!open || !isAllProjects || reachableInboxKey === "") return;
    untrack(() => {
      stacksReady = true;
      void inbox.loadAll(store, inboxProjects, { state: fetchScope });
      // Warm every project's stack graph too, so All projects can tell a stack
      // apart from an unrelated pair of PRs from the first paint.
      for (const project of inboxProjects) {
        void stacks.load(project.api, project.serverId, project.ctx).catch(() => {});
      }
    });
  });

  // Coming back from a review: put the scroller where it was and hand focus to
  // the row that was being read, so the list resumes rather than restarts. A
  // cold open has no remembered row and starts in the search field, as before.
  function restoreReadingPosition() {
    void tick().then(() => {
      if (runtime.shouldSuppressFocus) return;
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  // Remember where the list was read to. Captured continuously rather than on
  // exit, because the page unmounts without warning when a review opens.
  // Stack detection can change which cached guide belongs to a PR. Refresh the
  // local metadata after each graph update so target and own-delta guides never
  // borrow one another's timestamp.
  $effect(() => {
    if (!open || isAllProjects || !stackGraph || !prsApi || !prsServerId) return;
    const api = prsApi;
    const serverId = prsServerId;
    untrack(
      () => void store.loadGuideMetadata(api, serverId, prsCtx(), store.items).catch(() => {}),
    );
  });

  function scopeTo(next: string | null): void {
    if (next === scopedProjectKey) return;
    scopedProjectKey = next;
    reviewSelection.clear();
    aggregateSelectedKey = null;
    aggregateOpenKey = null;
    // A different scope is a different list — this is the one thing that
    // earns forgetting where the old one was read to.
    store.resetListView();
    store.needsReviewOnly = false;
    void loadActiveScope();
    void tick().then(() => searchEl?.focus());
  }

  function selectProject(option: ListProjectOption): void {
    if (!option.available) return;
    scopeTo(option.key);
  }

  function selectAllProjects(): void {
    scopeTo(null);
  }

  function removeProjectHistory(option: ListProjectOption): void {
    projectCatalog.remove({ serverId: option.serverId, projectRoot: option.projectKey });
  }

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeAllHosts(
      "prs.invalidated",
      (emittingServerId, { projectRoot: changedCwd }) => {
        if (!open) return;
        if (isAllProjects) {
          if (!inboxProjects.some((project) => project.serverId === emittingServerId && project.projectRoot === changedCwd)) return;
          clearTimeout(timer);
          timer = setTimeout(() => refreshList(), 500);
          return;
        }
        if (emittingServerId !== prsServerId) return;
        const scopedCtx = prsCtx().session;
        const ctxCwd = projectScopeOf(scopedCtx);
        if (changedCwd !== ctxCwd) return;
        clearTimeout(timer);
        timer = setTimeout(() => refreshList(), 500);
      },
    );
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  /** Open a pull request in the panel beside the list. The row stays selected,
   *  so closing the panel resumes the list on what was just read. */
  function selectPr(pr: PullRequestSummary, tab?: PrReviewTab) {
    const key = keyOf(pr);
    if (isAllProjects) {
      aggregateSelectedKey = key;
      aggregateOpenKey = key;
    } else {
      listView.selectedNumber = pr.number;
      listView.openNumber = pr.number;
    }
    // The row's verb picks the landing tab: a row that says Review opens on the
    // diff, everything else on Activity.
    store.prReviewTab = tab ?? "activity";
    const target = targetFor(pr);
    if (!target) return;
    void store.loadEfforts(target.api, target.serverId, target.ctx, [pr.number]);
    store.prefetchReview(target.api, target.serverId, target.ctx, pr.number);
  }

  /** Arrow-key movement only highlights. Nothing is fetched or mounted until
   *  Enter opens the row, so walking the list costs no requests. */
  function highlightPr(pr: PullRequestSummary) {
    if (isAllProjects) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
    const target = targetFor(pr);
    if (!target) return;
    void store.loadEfforts(target.api, target.serverId, target.ctx, [pr.number]);
  }

  // Checked PRs in the list order they're shown; stale checks (filtered out or
  // no longer loaded) simply drop out.
  const selected = $derived(
    filtered.filter((pr) => reviewSelection.has(keyOf(pr))),
  );
  // Batch Review/Guides need one project's (api, serverId, ctx) — scoped to a
  // project that's already true; All projects only when every checked PR is
  // from the same repository, so a mixed batch never silently picks one host
  // over another.
  const selectedProjects = $derived(
    new Set(selected.map((pr) => (isAllProjects ? (qualified.byPr.get(pr)?.serverId ?? "") + "\0" + (qualified.byPr.get(pr)?.projectRoot ?? "") : ""))),
  );
  const selectionSpansProjects = $derived(isAllProjects && selectedProjects.size > 1);

  function toggleReviewSelect(pr: PullRequestSummary) {
    const key = keyOf(pr);
    if (reviewSelection.has(key)) reviewSelection.delete(key);
    else reviewSelection.add(key);
  }

  function clearReviewSelection() {
    reviewSelection.clear();
    requestInputFocus();
  }

  function openReviewMode() {
    const items = selected.length > 0 ? selected : filtered;
    if (items.length === 0) return;
    if (selectionSpansProjects) {
      toasts.error("Select pull requests from one project to start a review", {
        description: "Review Mode reviews one repository's checkout at a time.",
      });
      return;
    }
    const target = targetFor(items[0]);
    if (!target) return;
    void session.openReviewMode(items, target.ctx, target.serverId);
  }

  // ── Opt-in guide generation ──
  // Guides no longer generate automatically; this queues them in the background
  // for the checked PRs so they're ready by the time each review opens.
  const guideEligible = $derived(
    selected.filter((pr) => pr.state === "open" && !pr.draft),
  );
  const guidesInFlight = $derived(
    [...store.guideStatus.values()].filter(
      (status) => status === "queued" || status === "generating",
    ).length,
  );

  function generateGuides() {
    if (selectionSpansProjects) {
      toasts.error("Select pull requests from one project to generate guides");
      return;
    }
    const numbers = guideEligible.map((pr) => pr.number);
    if (numbers.length === 0) return;
    const target = targetFor(guideEligible[0]);
    if (!target) return;
    const projectPath = isAllProjects ? target.ctx.session.projectPath ?? null : scopedProject?.projectKey ?? null;
    void store
      .requestGuides(target.api, target.serverId, target.ctx, numbers, {
        onSettled: ({ total, failed }) => {
          const toastOptions = {
            action: {
              label: "View",
              onAction: () => session.openPrs(projectPath),
            },
          };
          if (failed > 0) {
            toasts.error(
              failed === total
                ? `Couldn't generate ${total === 1 ? "the review guide" : `${total} review guides`}`
                : `${total - failed} of ${total} review guides ready; ${failed} failed`,
              toastOptions,
            );
            return;
          }
          toasts.success(
            total === 1
              ? `Review guide for PR #${numbers[0]} is ready.`
              : `${total} review guides are ready. Open a pull request to start reviewing.`,
            toastOptions,
          );
        },
      })
      .catch((error) => {
        toasts.error("Couldn't queue review guides", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
  }

  function refreshList() {
    if (isAllProjects) {
      void inbox.loadAll(store, inboxProjects, { state: fetchScope }, { force: true });
      return;
    }
    if (!prsApi || !prsServerId) return;
    store.filter = { state: fetchScope };
    void store.loadAll(prsApi, prsServerId, prsCtx(), { force: true });
  }

  // Narrowing within what is already loaded is free; widening past it is a
  // fetch. Only reload when the scope actually moves, so toggling Draft off and
  // on doesn't re-hit the host.
  function onStatusChange(next: string[]) {
    const scope = prFetchScope(next);
    const refetch = scope !== fetchScope;
    store.needsReviewOnly = false;
    listView.statusKeys = next;
    if (!refetch) return;
    if (isAllProjects) {
      void inbox.loadAll(store, inboxProjects, { state: scope });
      return;
    }
    if (!prsApi || !prsServerId) return;
    store.filter = { state: scope };
    void store.loadAll(prsApi, prsServerId, prsCtx());
  }

  // ── Keybindings ──
  // While the panel is open, Esc belongs to it: it collapses full screen, then
  // closes the review, and only an empty list page closes the page itself.
  useScope("prs", { active: () => open });
  useKeybinding("prs.close", () => close(), {
    enabled: () => open && !panelOpen,
  });
  function close() {
    session.router.close("prs");
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function onListKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = selectedKey
        ? listNavigationItems.findIndex((p) => keyOf(p) === selectedKey)
        : -1;
      const next =
        e.key === "ArrowDown"
          ? Math.min(idx + 1, listNavigationItems.length - 1)
          : Math.max(idx - 1, 0);
      if (listNavigationItems[next]) highlightPr(listNavigationItems[next]);
    } else if (e.key === "Enter" && selectedPr) {
      e.preventDefault();
      selectPr(selectedPr);
    } else if ((e.key === "x" || e.key === "X") && selectedPr) {
      // x checks the highlighted PR for review — keyboard-first multi-select,
      // matching the tasks list.
      e.preventDefault();
      toggleReviewSelect(selectedPr);
    }
  }

  // Viewport-rooted so clipping ancestors still apply inside the page's scroll
  // region.
  function observeEffort(node: HTMLElement, pr: PullRequestSummary | undefined) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          const target = pr ? targetFor(pr) : null;
          if (pr && target) {
            void store.loadEfforts(target.api, target.serverId, target.ctx, [pr.number]);
          }
          observer.disconnect();
        }
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  // Auto-load the next page as the list tail approaches. A sentinel rather than
  // an onscroll handler, so it is independent of which element is scrolling.
  function loadMoreSentinel(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (isAllProjects) {
          for (const project of inbox.projects) {
            if (project.hasMore && !project.loading) {
              void inbox.loadMore(store, project.serverId, project.projectRoot);
            }
          }
          return;
        }
        if (store.hasMore && !store.loadingMore && prsApi && prsServerId)
          void store.loadMore(prsApi, prsServerId, prsCtx());
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>

{#snippet reviewActions()}
  {#if selected.length > 0}
    <div
      class="flex items-center gap-1.5"
      transition:fly={{ y: -4, duration: 160 }}
    >
      <span
        class=" text-xs tabular-nums whitespace-nowrap text-muted-foreground"
      >
        {selected.length} selected
      </span>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onclick={clearReviewSelection}
        aria-label={`Clear ${selected.length} selected pull requests`}
      >
        Clear
      </Button>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-2.5 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        disabled={guideEligible.length === 0}
        onclick={generateGuides}
        aria-label={`Generate ${guideEligible.length} review guides in the background`}
      >
        {#if guidesInFlight > 0}
          <CircleNotchIcon
            size={12}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else}
          <BookOpenTextIcon size={12} class="shrink-0" />
        {/if}
        <span>Guides</span>
      </Button>
      <Button
        type="button"
        onclick={openReviewMode}
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-primary px-2.5 text-workspace-chrome font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
      >
        <PlayIcon size={12} weight="fill" class="shrink-0" />
        <span>Review</span>
      </Button>
    </div>
  {/if}
{/snippet}

{#snippet filterBar()}
  <ListFilterBar
    bind:query={listView.query}
    bind:searchEl
    compactText
    placeholder={view === "global"
      ? splitList
        ? "Search pull requests…"
        : "Search pull requests, branches, authors…"
      : "Search your inbox…"}
    filters={view === "global" ? listFilters : []}
  >
    {#snippet trailing()}
      {#if !splitList || statusFilterNarrowed}
        <ListStatusMenu
          options={statusOptions}
          selected={listView.statusKeys}
          onChange={onStatusChange}
          ariaLabel="Filter pull requests by status"
          compactText
        />
      {/if}
      {#if view === "global" && !splitList}
        <SortMenu
          bind:value={listView.sortMode}
          options={SORT_OPTIONS}
          ariaLabel="Sort pull requests"
          class="h-7 gap-1.5 rounded-lg px-2.5 text-xs font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:text-foreground"
        />
      {/if}
    {/snippet}
  </ListFilterBar>
{/snippet}

{#snippet pageActions()}
  {@render reviewActions()}
{/snippet}

{#if open}
  <!-- This page owns its titlebar chrome (see the `prs` route), so it paints to
       the window's top edge. The list uses the same fixed top measure as the
       Automations workspace; its position does not change with the sidebar. -->
  <div
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-card focus:outline-none [--pr-list-width:380px]"
    bind:clientWidth={pageWidth}
    role="dialog"
    aria-label="Pull Requests"
    tabindex="-1"
  >
    <!-- A pull request comes out from the side of this list rather than
         replacing it. The list narrows to a navigation column and the review
         takes the room that is left, so the queue stays readable while one item
         is open; E gives the review the whole surface, and Esc walks that back
         one step at a time. -->
    <!-- The list resizes in one layout pass, in both directions. It can, because
         the panel beside it never shares this flow: it is positioned over the
         room this width leaves (see below), so neither opening nor closing makes
         the queue relayout frame by frame while the panel moves. -->
    <div
      class="flex min-h-0 min-w-0 shrink-0 {splitList
        ? 'w-(--pr-list-width)'
        : 'w-full'}"
    >
    <ListPage
      split={splitList}
      projects={projectOptions}
      activeProjectKey={scopedProjectKey ?? ""}
      emptyProjectLabel="All projects"
      onSelectProject={selectProject}
      onRemoveProjectHistory={removeProjectHistory}
      onSelectAllProjects={selectAllProjects}
      allProjectsLabel="All projects"
      title="Pull requests"
      {summary}
      {view}
      onViewChange={(next) => (view = next)}
      globalLabel="All PRs"
      inboxLabel="My inbox"
      compactViewSwitcherText
      {unreadCount}
      onRefresh={refreshList}
      refreshing={activeRefreshing}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={close}
      actions={pageActions}
      filters={filterBar}
      contentOwnsScroll
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={listEl} onkeydown={onListKeydown} role="presentation">
        {#if inboxFailure.placement === "banner"}
          <!-- Partial failure: the rows that did load stay, and this line
               carries the part that didn't. -->
          <div class="px-3 pt-3">
            <div
              class="flex items-center gap-2.5 rounded-2xl border border-border bg-card px-3.5 py-3 text-workspace-chrome"
              role="alert"
            >
              {#if inboxFailure.kind === "github-auth"}
                <GithubConnectionRequired serverId={inboxFailure.serverId} />
              {:else}
                <span class="min-w-0 flex-1 truncate"
                  >{inboxFailure.summary}</span
                >
                <Button
                  type="button"
                  variant="ghost"
                  class="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onclick={refreshList}
                >
                  <ArrowsClockwiseIcon size={12} class="shrink-0" />
                  Retry
                </Button>
              {/if}
            </div>
          </div>
        {/if}
        {#if activeLoading && filtered.length === 0}
          <ListSkeleton identWidth={44} />
        {:else if !isAllProjects && store.error?.kind === "github-auth"}
          <PageEmpty
            icon={GithubLogoIcon}
            tone="muted"
            title="Connect GitHub to load pull requests."
          >
            {#if prsServerId}
              <GithubConnectionRequired serverId={prsServerId} layout="stacked" />
            {/if}
          </PageEmpty>
        {:else if inboxFailure.kind === "github-auth" && inboxFailure.placement === "page"}
          <PageEmpty
            icon={GithubLogoIcon}
            tone="muted"
            title="Connect GitHub to load pull requests."
          >
            <GithubConnectionRequired
              serverId={inboxFailure.serverId}
              layout="stacked"
            />
          </PageEmpty>
        {:else if !isAllProjects && store.error}
          <PageEmpty
            icon={WarningCircleIcon}
            tone="muted"
            title="Couldn’t load pull requests."
          >
            {store.error.message}
            {#snippet actions()}
              <Button type="button" variant="outline" onclick={refreshList}>
                <ArrowsClockwiseIcon size={14} />
                Retry
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if inboxFailure.kind === "generic" && inboxFailure.placement === "page"}
          <PageEmpty
            icon={WarningCircleIcon}
            tone="muted"
            title="Couldn’t load pull requests."
          >
            {inboxFailure.detail}
            {#snippet actions()}
              <Button type="button" variant="outline" onclick={refreshList}>
                <ArrowsClockwiseIcon size={14} />
                Retry
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if activeItems.length === 0}
          <PageEmpty icon={GitPullRequestIcon} title="No pull requests yet.">
            {isAllProjects
              ? "Open pull requests from any of your projects' remotes will show up here."
              : "Open pull requests from this project's remote will show up here."}
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={refreshList}
              >
                <ArrowsClockwiseIcon size={13} class="shrink-0" />
                Refresh
              </Button>
            {/snippet}
          </PageEmpty>
        {:else if view === "inbox"}
          {#if inboxGroups.length === 0}
            <ListEmpty title="Inbox zero."
              >No pull request is waiting on you.</ListEmpty
            >
          {:else}
            <VirtualList
              items={inboxVirtualItems}
              height={contentHeight}
              itemSize={(index) =>
                inboxVirtualItems[index].kind === "header" ? 36 : 55}
              keyOf={(item) => item.key}
              activeKey={inboxActiveKey}
              scrollOffset={listView.scrollTop}
              onAfterScroll={({ offset }) => (listView.scrollTop = offset)}
            >
              {#snippet children(item, _index, style)}
                <div {style}>
                  {#if item.kind === "header"}
                    <ListGroup
                      label={item.group.label}
                      count={item.group.rows.length}
                      open={!listView.collapsedGroups[`inbox:${item.group.key}`]}
                      onToggle={() => {
                        const groupKey = `inbox:${item.group.key}`;
                        listView.collapsedGroups[groupKey] =
                          !listView.collapsedGroups[groupKey];
                      }}
                      note={item.group.note}
                      accent={item.group.accent}
                    >
                      {#snippet children()}{/snippet}
                    </ListGroup>
                  {:else}
                  <InboxRow
                    row={item.row}
                    hot={!!item.group.accent}
                    selected={selectedKey === item.row.key}
                    onSelect={() => {
                      const pr = prByKey(item.row.key);
                      if (pr)
                        selectPr(
                          pr,
                          item.row.primary?.label === "Review"
                            ? "diff"
                            : undefined,
                        );
                    }}
                    onContextMenu={(event) => {
                      const pr = prByKey(item.row.key);
                      if (pr) openPrContextMenu(event, pr);
                    }}
                  />
                  {/if}
                </div>
              {/snippet}
            </VirtualList>
          {/if}
        {:else if groups.length === 0}
          <ListEmpty title="Nothing matches">
            Clear the filters or widen the search.
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={() => {
                  listView.query = "";
                  listView.minesOnly = false;
                  listView.failingOnly = false;
                  onStatusChange([...OPEN_PR_STATUS_KEYS]);
                }}
              >
                Clear filters
              </Button>
            {/snippet}
          </ListEmpty>
        {:else}
          <VirtualList
            items={globalVirtualItems}
            height={contentHeight}
            itemSize={(index) =>
              globalVirtualItems[index].kind === "header"
                ? 36
                : splitList
                  ? 52
                  : 44}
            keyOf={(item) => item.key}
            activeKey={globalActiveKey}
            scrollOffset={listView.scrollTop}
            onAfterScroll={({ offset }) => (listView.scrollTop = offset)}
          >
            {#snippet children(item, _index, style)}
              <div {style}>
                {#if item.kind === "header"}
                  <ListGroup
                    label={item.group.label}
                    count={item.group.rows.length}
                    open={!listView.collapsedGroups[item.group.key]}
                    onToggle={() =>
                      (listView.collapsedGroups = {
                        ...listView.collapsedGroups,
                        [item.group.key]:
                          !listView.collapsedGroups[item.group.key],
                      })}
                  >
                    {#snippet children()}{/snippet}
                  </ListGroup>
                {:else}
                {@const pr = prByKey(item.row.key)}
                {@const rowSelected =
                  selectedKey === item.row.key ||
                  reviewSelection.has(item.row.key)}
                {#snippet reviewCheckbox()}
                  <button
                    type="button"
                    class="mr-2 grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-xs transition-opacity {reviewSelection.has(
                      item.row.key,
                    )
                      ? 'bg-primary text-primary-foreground opacity-100'
                      : 'bg-[var(--wash-3)] text-transparent opacity-0 group-hover:opacity-100'}"
                    onclick={() => {
                      if (pr) toggleReviewSelect(pr);
                    }}
                    aria-pressed={reviewSelection.has(item.row.key)}
                    aria-label="Select for review"
                  >
                    ✓
                  </button>
                {/snippet}
                <div use:observeEffort={pr}>
                  {#if splitList}
                    <ListRailRow
                      row={item.row}
                      selected={rowSelected}
                      leading={reviewCheckbox}
                      onSelect={() => {
                        if (pr) selectPr(pr);
                      }}
                      onContextMenu={(event) => {
                        if (pr) openPrContextMenu(event, pr);
                      }}
                    />
                  {:else}
                    <ListRow
                      row={item.row}
                      identWidth={44}
                      selected={rowSelected}
                      leading={reviewCheckbox}
                      onSelect={() => {
                        if (pr) selectPr(pr);
                      }}
                      onContextMenu={(event) => {
                        if (pr) openPrContextMenu(event, pr);
                      }}
                    />
                  {/if}
                </div>
                {/if}
              </div>
            {/snippet}
            {#snippet footer()}
              {#if isAllProjects ? (inboxHasMore || inboxLoadingMore) : (store.hasMore || store.loadingMore)}
                <div use:loadMoreSentinel class="flex items-center justify-center py-3">
                  <Button
                    type="button"
                    class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isAllProjects ? inboxLoadingMore : store.loadingMore}
                    onclick={() => {
                      if (isAllProjects) {
                        for (const project of inbox.projects) {
                          if (project.hasMore) void inbox.loadMore(store, project.serverId, project.projectRoot);
                        }
                        return;
                      }
                      if (prsApi && prsServerId)
                        void store.loadMore(prsApi, prsServerId, prsCtx());
                    }}
                  >
                    {(isAllProjects ? inboxLoadingMore : store.loadingMore) ? "Loading…" : "Load more pull requests"}
                  </Button>
                </div>
              {/if}
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </ListPage>
    </div>

    {#if panelOpen && openPr && openTarget}
      <!-- Out of the list's flow on purpose, not just when full screen: it
           covers the room the list's width leaves rather than claiming its own.
           In flow, this panel's arrival and departure were layout events — the
           list had to travel with it, animating a width that can never reach the
           compositor, in the same frames PrDetailPanel mounts in. Over the top,
           the fly is transform and opacity alone and nothing relayouts, so both
           directions cost one layout pass. -->
      <div
        class="flex flex-col bg-background {panelFullScreen
          ? 'absolute inset-0 z-20'
          : 'absolute inset-y-0 right-0 left-(--pr-list-width) z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'}"
        transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
      >
        <PrDetailPanel
          number={openPr.number}
          api={openTarget.api}
          serverId={openTarget.serverId}
          ctx={openTarget.ctx}
          title={openPr.title}
          fullScreen={panelFullScreen}
          onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
          onOpenRoute={() => openPrRoute(openPr, openTarget)}
          onClose={closePanel}
          onStep={stepPanel}
        />
      </div>
    {/if}

    {#if prContextMenu}
      {@const menuPr = prContextMenu.pr}
      <PrContextMenu
        x={prContextMenu.x}
        y={prContextMenu.y}
        pr={menuPr}
        onOpen={() => selectPr(menuPr)}
        onReview={() => selectPr(menuPr, "diff")}
        onOpenWeb={prUrl(menuPr) ? () => openPrExternal(menuPr) : undefined}
        onClose={() => (prContextMenu = null)}
      />
    {/if}
  </div>
{/if}
