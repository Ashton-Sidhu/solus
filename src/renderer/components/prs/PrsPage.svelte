<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteSet } from "svelte/reactivity";
  import {
    GitPullRequestIcon,
    ArrowsClockwiseIcon,
    BookOpenTextIcon,
    CircleNotchIcon,
    PlayIcon,
    UserIcon,
    WarningIcon,
  } from "phosphor-svelte";
  import type { PullRequestSummary } from "../../../shared/providers";
  import type { IpcContext } from "../../../shared/types";
  import {
    getWorkspaceContext,
    getSettingsContext,
    runtime,
    getSessionSidebarStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { serverConnections } from "@client-core/server-connections";
  import { subscribeAllHosts } from "@client-core/host-events";
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
  import { groupStackedPrRows } from "./lib/stack-grouping";
  import GithubConnectionRequired from "./GithubConnectionRequired.svelte";
  import PrDetailPanel from "./PrDetailPanel.svelte";
  import PrContextMenu from "./PrContextMenu.svelte";

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const sessionSidebar = getSessionSidebarStore();
  const store = session.prsStore;
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
  // opens Review Mode over just those instead of every filtered PR.
  const reviewSelection = new SvelteSet<number>();

  // ── Project scope ──
  // The list is scoped to one project at a time. `null` follows the project
  // currently being worked in (the default); a string pins another project
  // chosen from the switcher. Every PR fetch goes through `prsCtx()` so data
  // and cache keys stay consistent with the chosen project.
  let selectedProjectPath = $state<string | null>(null);

  const currentProjectPath = $derived(
    sessionSidebar.activeProjectKey === "~"
      ? ""
      : sessionSidebar.activeProjectKey,
  );
  const activeProjectPath = $derived(selectedProjectPath ?? currentProjectPath);
  function prsCtx(): IpcContext {
    return activeProjectPath === currentProjectPath || !activeProjectPath
      ? session.ctx
      : session.ctxForDirectory(activeProjectPath);
  }

  // A project-scoped page follows the focused session for that project. A bare
  // standalone list has no checkout owner to infer, so primary is the explicit
  // default that preserves the single-host behavior.
  const prsSourceTabId = $derived.by(() => {
    if (!activeProjectPath) return null;
    const focusedTabId = session.focusedChatTabId ?? session.activeTabId;
    const ordered = [focusedTabId, ...session.tabOrder.filter((id) => id !== focusedTabId)];
    return ordered.find((tabId) => {
      const run = session.runFor(tabId);
      return run?.gitContext?.repoRoot === activeProjectPath ||
        run?.workingDirectory === activeProjectPath;
    }) ?? null;
  });
  const prsApi = $derived(
    prsSourceTabId ? session.apiFor(prsSourceTabId) : serverConnections.primaryApi(),
  );
  const prsServerId = $derived(serverConnections.serverIdForApi(prsApi));

  const projectOptions = $derived(
    sessionSidebar.projectSummaries
      .filter((project) => project.projectKey !== "~")
      .map((project) => ({
        projectKey: project.projectKey,
        label: project.label,
      })),
  );

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
  const openCount = $derived(
    store.items.filter((pr) => pr.state === "open").length,
  );

  // ── The shared row grammar's view of a PR ──
  // `isMine` needs the connected viewer's login; until `loadViewer` lands it
  // falls back to "nobody is me", which under-fills the Yours filter rather than
  // mislabelling someone else's PR as yours.
  const rowContext = $derived<PrRowContext>({
    checks: (number) => store.checksFor(prsServerId, prsCtx(), number),
    isMine: (pr) => !!viewerLogin && pr.author === viewerLogin,
  });

  const searched = $derived(
    sortPrs(
      filterPrs(
        store.needsReviewOnly
          ? store.items.filter((pr) => pr.needsMyReview)
          : store.items,
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
        const checks = store.checksFor(prsServerId, prsCtx(), pr.number);
        return (
          !!checks &&
          checks.headSha === pr.headSha &&
          checks.state === "failing"
        );
      });
    }
    return rows;
  });

  const stackGraph = $derived(
    settings.stackedPrsEnabled && stacksReady
      ? stacks.graphFor(prsServerId, activeProjectPath)
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

  const groups = $derived(prGroups(filtered, rowContext, now, stackParents));
  // The row's verb picks the tab it lands on: a row that says Review opens on
  // the diff, everything else on Activity.
  const inboxGroups = $derived(
    prInboxGroups(store.items, rowContext, now, {
      review: (pr) => selectPr(pr, "diff"),
      open: (pr) => selectPr(pr),
      openExternal: openPrExternal,
    }, statuses),
  );
  const inboxVirtualItems = $derived(
    virtualGroupItems(inboxGroups, (row) => row.key),
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
      (item) =>
        item.kind === "row" &&
        item.row.key === String(listView.selectedNumber),
    )?.key ?? null,
  );
  const globalActiveKey = $derived(
    globalVirtualItems.find(
      (item) =>
        item.kind === "row" &&
        item.row.key === String(listView.selectedNumber),
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
            const checks = store.checksFor(prsServerId, prsCtx(), pr.number);
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
    const awaiting = store.items.filter(
      (pr) =>
        pr.state === "open" &&
        !pr.draft &&
        pr.needsMyReview &&
        !rowContext.isMine(pr),
    ).length;
    const totalOpen = openCount;
    const mergedRecently = store.items.filter(
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

  // Publish the visible order so the review's crumb switcher and its `n of N`
  // stepper walk exactly these rows, in exactly this order. Written from the
  // page because this is where the filters and the stack grouping resolve.
  $effect(() => {
    const order = listNavigationItems.map((pr) => pr.number);
    untrack(() => (store.listOrder = order));
  });

  const selectedPr = $derived(
    listView.selectedNumber
      ? (store.items.find((p) => p.number === listView.selectedNumber) ?? null)
      : null,
  );

  // ── The detail panel ──
  // A pull request comes out from the side of the list rather than replacing it:
  // the rows stay on screen so the queue is still readable while one item is
  // being reviewed. Below the width where both fit, the panel covers the list
  // instead — a 380px column beside a 380px review is neither.
  const openNumber = $derived(listView.openNumber);
  const panelOpen = $derived(openNumber !== null);
  const openPr = $derived(
    openNumber ? (store.items.find((p) => p.number === openNumber) ?? null) : null,
  );
  const roomForSplit = $derived(pageWidth >= 1040);
  const panelFullScreen = $derived(
    panelOpen && (listView.panelFullScreen || !roomForSplit),
  );
  const splitList = $derived(panelOpen && !panelFullScreen);

  function closePanel() {
    listView.openNumber = null;
    listView.panelFullScreen = false;
    void tick().then(() => {
      const selectedRow = listEl?.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selectedRow) selectedRow.focus();
      else searchEl?.focus();
    });
  }

  function toggleFullScreen() {
    listView.panelFullScreen = !listView.panelFullScreen;
  }

  /** Step to the pull request before or after the open one, in the list's own
   *  order — what J / K and the panel's stepper walk. */
  function stepPanel(delta: number) {
    if (listNavigationItems.length === 0 || openNumber === null) return;
    const index = listNavigationItems.findIndex((p) => p.number === openNumber);
    if (index === -1) return;
    const next =
      listNavigationItems[
        (index + delta + listNavigationItems.length) % listNavigationItems.length
      ];
    // Stepping is a move inside one reading session, so it keeps the tab you
    // are reading; only picking a row afresh re-decides that.
    if (next && next.number !== openNumber) selectPr(next, store.prReviewTab);
  }

  function prByNumber(key: string): PullRequestSummary | undefined {
    return store.items.find((pr) => String(pr.number) === key);
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

  function openPrContextMenu(event: MouseEvent, pr: PullRequestSummary) {
    event.preventDefault();
    event.stopPropagation();
    listView.selectedNumber = pr.number;
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
    const requestedProjectPath =
      session.router.params("prs")?.projectPath ?? null;
    if (!open) return;
    untrack(() => {
      selectedProjectPath =
        requestedProjectPath && requestedProjectPath !== currentProjectPath
          ? requestedProjectPath
          : null;
      store.filter = { state: fetchScope };
      void store.loadAll(prsApi, prsServerId, prsCtx());
      void store
        .loadViewer(prsApi, prsServerId, prsCtx())
        .then((login) => (viewerLogin = login))
        .catch(() => {});
      stacksReady = false;
      void stacks.load(prsApi, prsServerId, prsCtx()).then(
        () => (stacksReady = true),
        () => (stacksReady = false),
      );
      restoreReadingPosition();
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
    if (!open || !stackGraph) return;
    untrack(
      () => void store.loadGuideMetadata(prsApi, prsServerId, prsCtx(), store.items).catch(() => {}),
    );
  });

  function selectProject(path: string) {
    const next = path === currentProjectPath ? null : path;
    if (next === selectedProjectPath) return;
    selectedProjectPath = next;
    reviewSelection.clear();
    // A different project is a different list — this is the one thing that
    // earns forgetting where the old one was read to.
    store.resetListView();
    store.needsReviewOnly = false;
    store.filter = { state: "open" };
    void store.loadAll(prsApi, prsServerId, prsCtx());
    void store
      .loadViewer(prsApi, prsServerId, prsCtx())
      .then((login) => (viewerLogin = login))
      .catch(() => {});
    stacksReady = false;
    void stacks.load(prsApi, prsServerId, prsCtx()).then(
      () => (stacksReady = true),
      () => (stacksReady = false),
    );
    void tick().then(() => searchEl?.focus());
  }

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeAllHosts(
      "prs.invalidated",
      (emittingServerId, { projectRoot: changedCwd }) => {
        if (emittingServerId !== prsServerId) return;
        if (!open) return;
        const scopedCtx = prsCtx().session;
        const ctxCwd = scopedCtx.projectPath || scopedCtx.workingDirectory;
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
    listView.selectedNumber = pr.number;
    listView.openNumber = pr.number;
    // The row's verb picks the landing tab: a row that says Review opens on the
    // diff, everything else on Activity.
    store.prReviewTab = tab ?? "activity";
    void store.loadEfforts(prsApi, prsServerId, prsCtx(), [pr.number]);
    store.prefetchReview(prsApi, prsServerId, prsCtx(), pr.number);
  }

  /** Arrow-key movement only highlights. Nothing is fetched or mounted until
   *  Enter opens the row, so walking the list costs no requests. */
  function highlightPr(pr: PullRequestSummary) {
    listView.selectedNumber = pr.number;
    void store.loadEfforts(prsApi, prsServerId, prsCtx(), [pr.number]);
  }

  // Checked PRs in the list order they're shown; stale checks (filtered out or
  // no longer loaded) simply drop out.
  const selected = $derived(
    filtered.filter((pr) => reviewSelection.has(pr.number)),
  );

  function toggleReviewSelect(pr: PullRequestSummary) {
    if (reviewSelection.has(pr.number)) reviewSelection.delete(pr.number);
    else reviewSelection.add(pr.number);
  }

  function clearReviewSelection() {
    reviewSelection.clear();
    requestInputFocus();
  }

  function openReviewMode() {
    const items = selected.length > 0 ? selected : filtered;
    if (items.length === 0) return;
    void session.openReviewMode(items, prsCtx(), prsServerId);
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
    const numbers = guideEligible.map((pr) => pr.number);
    if (numbers.length === 0) return;
    const projectPath = activeProjectPath;
    void store
      .requestGuides(prsApi, prsServerId, prsCtx(), numbers, {
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
      const idx = listView.selectedNumber
        ? listNavigationItems.findIndex(
            (p) => p.number === listView.selectedNumber,
          )
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
  function observeEffort(node: HTMLElement, number: number) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void store.loadEfforts(prsApi, prsServerId, prsCtx(), [number]);
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
        if (store.hasMore && !store.loadingMore)
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
        class="font-mono text-xs tabular-nums whitespace-nowrap text-muted-foreground"
      >
        {selected.length} selected
      </span>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onclick={clearReviewSelection}
        aria-label={`Clear ${selected.length} selected pull requests`}
      >
        Clear
      </Button>
      <Button
        type="button"
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-muted px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
        class="inline-flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-primary px-2.5 text-[0.8125rem] font-medium text-primary-foreground transition-[filter] duration-100 hover:brightness-[1.07]"
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
        />
      {/if}
      {#if view === "global" && !splitList}
        <SortMenu
          bind:value={listView.sortMode}
          options={SORT_OPTIONS}
          ariaLabel="Sort pull requests"
          class="h-7 gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] hover:text-foreground"
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
    class="@container relative flex min-h-0 flex-1 overflow-hidden bg-card focus:outline-none"
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
    <div
      class="flex min-h-0 min-w-0 shrink-0 transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none {splitList
        ? 'w-[380px]'
        : 'w-full'}"
    >
    <ListPage
      split={splitList}
      projects={projectOptions}
      activeProjectKey={activeProjectPath}
      emptyProjectLabel="Choose a project"
      onSelectProject={selectProject}
      title="Pull requests"
      {summary}
      {view}
      onViewChange={(next) => (view = next)}
      globalLabel="All PRs"
      inboxLabel="My inbox"
      {unreadCount}
      onRefresh={refreshList}
      refreshing={store.loading}
      onClose={close}
      actions={pageActions}
      filters={filterBar}
      contentOwnsScroll
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={listEl} onkeydown={onListKeydown} role="presentation">
        {#if store.loading && filtered.length === 0}
          <ListSkeleton identWidth={44} />
        {:else if store.error?.kind === "github-auth"}
          <PageEmpty title="Connect GitHub to load pull requests.">
            <GithubConnectionRequired serverId={prsServerId} />
          </PageEmpty>
        {:else if store.error}
          <PageEmpty title="Couldn’t load pull requests.">
            {store.error.message}
            {#snippet actions()}
              <Button type="button" variant="outline" onclick={refreshList}>Retry</Button>
            {/snippet}
          </PageEmpty>
        {:else if store.items.length === 0}
          <PageEmpty icon={GitPullRequestIcon} title="No pull requests yet.">
            Open pull requests from this project's remote will show up here.
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-muted px-3 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                      collapsible={false}
                      note={item.group.note}
                      accent={item.group.accent}
                    >
                      {#snippet children()}{/snippet}
                    </ListGroup>
                  {:else}
                  <InboxRow
                    row={item.row}
                    hot={!!item.group.accent}
                    selected={String(listView.selectedNumber) === item.row.key}
                    onSelect={() => {
                      const pr = prByNumber(item.row.key);
                      if (pr)
                        selectPr(
                          pr,
                          item.row.primary?.label === "Review"
                            ? "diff"
                            : undefined,
                        );
                    }}
                    onContextMenu={(event) => {
                      const pr = prByNumber(item.row.key);
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
                class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                {@const pr = prByNumber(item.row.key)}
                {@const rowSelected =
                  String(listView.selectedNumber) === item.row.key ||
                  reviewSelection.has(Number(item.row.key))}
                {#snippet reviewCheckbox()}
                  <button
                    type="button"
                    class="mr-2 grid size-4 shrink-0 cursor-pointer place-items-center rounded border-0 text-xs transition-opacity {reviewSelection.has(
                      Number(item.row.key),
                    )
                      ? 'bg-primary text-primary-foreground opacity-100'
                      : 'bg-[var(--wash-3)] text-transparent opacity-0 group-hover:opacity-100'}"
                    onclick={() => {
                      if (pr) toggleReviewSelect(pr);
                    }}
                    aria-pressed={reviewSelection.has(Number(item.row.key))}
                    aria-label="Select for review"
                  >
                    ✓
                  </button>
                {/snippet}
                <div use:observeEffort={Number(item.row.key)}>
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
              {#if store.hasMore || store.loadingMore}
                <div use:loadMoreSentinel class="flex items-center justify-center py-3">
                  <Button
                    type="button"
                    class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={store.loadingMore}
                    onclick={() => void store.loadMore(prsApi, prsServerId, prsCtx())}
                  >
                    {store.loadingMore ? "Loading…" : "Load more pull requests"}
                  </Button>
                </div>
              {/if}
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </ListPage>
    </div>

    {#if openNumber !== null}
      <div
        class="flex flex-col bg-background {panelFullScreen
          ? 'absolute inset-0 z-20'
          : 'relative min-w-0 flex-1 shadow-[-1px_0_0_var(--hairline-strong),-18px_0_30px_-26px_rgba(0,0,0,.28)]'}"
        transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
      >
        <PrDetailPanel
          number={openNumber}
          api={prsApi}
          serverId={prsServerId}
          ctx={prsCtx()}
          title={openPr?.title ?? ""}
          fullScreen={panelFullScreen}
          onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
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
