<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import { tick, untrack } from "svelte";
  import { fly } from "svelte/transition";
  import { SvelteMap } from "svelte/reactivity";
  import type { PrFilter, PullRequest } from "@solus/contracts/providers";
  import { projectScopeOf } from "@solus/contracts/types";
  import {
    getClientShellContext,
    getSurfaceContext,
    getPullRequestsContext,
    runtime,
    projectsStore,
    serversStore,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hostKey } from "@solus/client-core/host-key";
  import { subscribeAllHosts } from "@solus/client-core/host-events";
  import { Button } from "../ui/button";
  import {
    ListEmpty,
    ListPage,
    ListProjectFilter,
    syncStamp,
    virtualGroupItems,
    type ListGroupSpec,
    type ListProjectOption,
  } from "../ui/list-page";
  import type { PrChecksState, PrSortMode } from "./lib/pr-utils";
  import { arrangePrList } from "./lib/pr-list-arrange";
  import {
    showsPrDetailPanel,
    showsPrPageSkeleton,
    type ScopeSwitchPhase,
  } from "./lib/pr-list-loading";
  import { isAuthoredBy, isReviewRequestedFrom, PR_LIST_LOAD_CAP, prFetchScope, prGroups, type PrRowContext, type PrRowSpec } from "./lib/prs-list-view";
  import { PrListSearch } from "./lib/pr-list-search.svelte";
  import { prListPreferencesOf, writePrListPreferences } from "./lib/pr-list-memory";
  import type { ProjectPrs } from "../../contexts/prs/prs.store.svelte";
  import type { PrReviewTab } from "../../contexts/prs/pr-view.svelte";
  import { flattenQualifiedProjects, qualifiedKeyOf, type PrTarget } from "./lib/pr-cross-project";
  import {
    prInboxFailure,
    type PrInboxFailure,
  } from "./lib/pr-inbox-failure";
  import PrDetailPanel from "./PrDetailPanel.svelte";
  import PrListBody from "./PrListBody.svelte";
  import PrContextMenu from "./PrContextMenu.svelte";
  import PrActionConfirm from "../pr-review/PrActionConfirm.svelte";
  import {
    prMergeConfirmation,
    prRowActionForKey,
    prRowActions,
    runPrRowAction,
    type PrRowActionKind,
  } from "./lib/pr-row-actions";
  import { ShiftHeld } from "./lib/shift-held.svelte";
  import PrsPageSkeleton from "./PrsPageSkeleton.svelte";
  import PrListToolbar from "./PrListToolbar.svelte";
  import PrListStates from "./PrListStates.svelte";
  import PrReviewActions from "./PrReviewActions.svelte";
  import PrCondensedCrumbs from "./PrCondensedCrumbs.svelte";
  import PrPanelResizeHandle from "./PrPanelResizeHandle.svelte";
  import {
    canSplitPrPanel,
    clampPrPanelWidth,
    prPanelWidth,
    readSavedPrPanelWidth,
    savePrPanelWidth,
  } from "./lib/pr-panel-width";
  import { clearPrFilters, prAuthorOptions, prFilterGroups, prLabelOptions } from "./lib/pr-filter-menu";
  import { PrReviewSelection } from "./lib/pr-review-selection.svelte";
  import { queueReviewGuides } from "./lib/pr-guide-batch";
  import { PrPageScope } from "./lib/pr-page-scope.svelte";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import type { InlinePageProps } from "../ui/lib/pane-surface";

  let { paneId }: InlinePageProps = $props();

  const session = getSurfaceContext();
  const shell = getClientShellContext();
  // The board is mounted by the workspace and by the cloud console alike
  // (docs/plans/cloud-console-native-pages.md §9). Review Mode, guide
  // generation, the detail panel (it prepares a worktree), the sidebar's live
  // projects, and the page's close need a workspace; a console row opens the
  // pull request on the code host.
  const workspace = session.workspace;
  const pullRequests = getPullRequestsContext();
  const pane = paneActions(() => paneId);
  const store = pullRequests.projects;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // A console page is open for as long as it is mounted.
  const open = $derived(workspace?.router.at("prs") ?? true);

  // ── List state ──
  // Everything that describes *how the list was left* lives in the store, not
  // here: opening a pull request replaces this page, so these locals would be
  // destroyed on every open and the list would forget the review it just
  // returned from.
  const listView = $derived(pullRequests.view.listView);
  let searchEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | undefined>();
  let contentHeight = $state(0);
  let pageWidth = $state(0);
  const viewerLogins = new SvelteMap<string, string>();
  let prContextMenu = $state<{ pr: PullRequest; x: number; y: number } | null>(null);

  // Shift held while this page is open shows every row's quick actions.
  const shiftHeld = new ShiftHeld();
  $effect(() => {
    if (!open) return;
    return shiftHeld.listen(window);
  });
  // A merge cannot be taken back, so every path to it asks first. The row is
  // held by key and read back, so the dialog describes the pull request as it
  // is now.
  let mergeKey = $state<string | null>(null);
  let mergeConfirmOpen = $state(false);

  // Tick the clock so relative row times age instead of freezing at load.
  let now = $state(Date.now());
  $effect(() => {
    if (!open) return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  // The sort and filters are this device's choice, restored the next time the
  // list opens (`PrView` reads them back). Written on every change.
  $effect(() => {
    const preferences = prListPreferencesOf(listView);
    untrack(() => writePrListPreferences(preferences));
  });

  // ── Project scope ── one project, or every project; see `PrPageScope`.
  const pageScope = new PrPageScope(session);

  // ── Review multi-select ── `x` or the row's checkbox.
  const reviewSelection = new PrReviewSelection({
    rows: () => sections.flatMap((section) => section.prs),
    keyOf: (pr) => keyOf(pr),
    projectOf: (pr) => {
      const owner = pageScope.allProjects ? qualified.byPr.get(pr) : undefined;
      return owner ? `${owner.serverId}\0${owner.projectRoot}` : "";
    },
  });
  const selected = $derived(reviewSelection.selected);

  // A switch is a different list, not a refresh of this one, so the rows on
  // screen stop being the truth the moment the scope changes. The scope effect
  // drives this through to `idle` once the scope that replaced them has read.
  let scopeSwitch = $state<ScopeSwitchPhase>("idle");

  /** The one project the single-project list is showing, or null with no
   *  host. The store is a map and holds no notion of "current" — the page does. */
  const shown = $derived(store.at(pageScope.serverId, pageScope.projectPath));
  /** The projects the footer paginates. Each pages itself. */
  const paginating = $derived(pageScope.allProjects ? store.all : shown ? [shown] : []);

  // Each reachable project, carrying whatever the PR store has loaded for it.
  const qualified = $derived(
    flattenQualifiedProjects(pageScope.projectTargets.map((project) => ({
      ...project,
      items: store.at(project.serverId, project.projectRoot)?.items ?? [],
    }))),
  );
  const aggregateKeyFor = $derived(qualifiedKeyOf(qualified.byPr));
  const allProjectScopes = $derived(
    pageScope.projectTargets.flatMap((project) => store.at(project.serverId, project.projectRoot) ?? []),
  );
  const hasMorePullRequests = $derived(paginating.some((project) => project.hasMore));
  const loadingMorePullRequests = $derived(paginating.some((project) => project.loadingMore));
  const allProjectsLoading = $derived(allProjectScopes.some((project) => project.loading));
  const activeRefreshing = $derived(pageScope.allProjects ? allProjectsLoading : (shown?.loading ?? false));

  const SORT_OPTIONS: { value: PrSortMode; label: string }[] = [
    { value: "ready", label: "Merge readiness" },
    { value: "created", label: "Created" },
    { value: "updated", label: "Updated" },
  ];

  // The fetch scope the statuses imply — merged
  // and closed pull requests are a separate page on the host, so asking for
  // them has to widen the load before anything can be filtered.
  const fetchScope = $derived(prFetchScope(listView.statusKeys));

  // ── Search ── typed text narrows the rows on screen; the host is asked
  // once typing stops. Qualifiers (`label:bug`, `author:me`) read the same.
  const search = new PrListSearch(() => listView.query);
  const listFilter = $derived<PrFilter>(
    search.hostQuery ? { state: fetchScope, query: search.hostQuery } : { state: fetchScope },
  );

  // The item list this visit is reading: one project's rows, or every
  // project's merged together.
  const activeItems = $derived(
    pageScope.allProjects
      ? qualified.items
      : pageScope.projectPath
        ? (shown?.items ?? [])
        : [],
  );
  // The cap: past this many rows the list asks for a narrower search
  // instead of another page.
  const loadCapped = $derived(activeItems.length >= PR_LIST_LOAD_CAP);
  // A host that is still dialing is not an empty list: until it settles the
  // page is still on its way, so the skeleton holds rather than the list
  // claiming there is nothing to read.
  const hostsConnecting = $derived(
    pageScope.projectOptions.some(
      (option) => serversStore.statusFor(option.serverId) === "connecting",
    ),
  );
  // Is the scope in view reading right now — a first load, a refresh, or a
  // page. Says nothing about what the page should show; `showsPrPageSkeleton`
  // decides that.
  const activeScopeReading = $derived(
    pageScope.allProjects ? allProjectsLoading || hostsConnecting : (shown?.loading ?? false),
  );
  const activeLoading = $derived(
    pageScope.allProjects ? activeScopeReading && activeItems.length === 0 : activeScopeReading,
  );
  // Has the host answered the search in the field? Until it has, the rows on
  // screen are the previous answer, narrowed here by the typed text.
  const hostAnswered = $derived(
    !activeScopeReading &&
      (pageScope.allProjects ? allProjectScopes : shown ? [shown] : []).every(
        (project) => (project.filter.query ?? "") === search.typedHostQuery,
      ),
  );
  // A failed project keeps its last-safe rows. Partial failures use a toast;
  // when no rows loaded, the error takes the page.
  const projectsFailure = $derived(
    pageScope.allProjects
      ? prInboxFailure(
          pageScope.projectTargets.flatMap((project) => {
            const scope = store.at(project.serverId, project.projectRoot);
            return scope ? [{ serverId: project.serverId, label: project.label, error: scope.error }] : [];
          }),
          activeItems.length > 0,
        )
      : ({ kind: "none", placement: "none" } satisfies PrInboxFailure),
  );

  // ── The shared row grammar's view of a PR ──
  // `isMine` needs the connected viewer's login; until `loadViewer` lands it
  // falls back to "nobody is me", which files every row under Others rather
  // than mislabelling someone else's PR as yours. `checks` resolves through the
  // PR's own project across every project — a bare PR number cannot tell two
  // repos apart.
  const rowContext = $derived<PrRowContext>({
    checks: (pr) => {
      const scope = lookupScopeFor(pr);
      return scope ? pullRequests.checks.summaryFor(scope.serverId, scope.ctx, pr.number) : undefined;
    },
    guideStatus: (pr) => {
      const scope = lookupScopeFor(pr);
      return scope
        ? pullRequests.guides.statusFor(scope.serverId, scope.ctx, pr.number)
        : undefined;
    },
    isMine: (pr) => isAuthoredBy(pr, viewerLoginFor(pr)),
    isReviewRequested: (pr) => isReviewRequestedFrom(pr, viewerLoginFor(pr)),
  });

  function viewerLoginFor(pr: PullRequest): string | null {
    const owner = pageScope.allProjects ? qualified.byPr.get(pr) : undefined;
    const serverId = owner?.serverId ?? pageScope.serverId;
    const projectPath = owner?.projectRoot ?? pageScope.projectPath;
    return serverId && projectPath
      ? (viewerLogins.get(hostKey(serverId, projectPath)) ?? null)
      : null;
  }

  function currentChecksState(pr: PullRequest): PrChecksState | null {
    const checks = rowContext.checks(pr);
    return checks?.headSha === pr.headSha && checks.state !== "none" ? checks.state : null;
  }

  const arranged = $derived(
    arrangePrList(activeItems, listView, { typed: search.typed, hostAnswered }, {
      rowContext,
      viewerLogin: viewerLoginFor,
      checksState: currentChecksState,
      hasGuide: (pr) => {
        const scope = lookupScopeFor(pr);
        return !!scope && !!pullRequests.guides.metadataFor(scope.serverId, scope.ctx, pr.number)?.generatedAt;
      },
    }),
  );
  const { searched, filtered, sectioned, sections } = $derived(arranged);
  const showPageSkeleton = $derived(
    showsPrPageSkeleton(scopeSwitch, activeLoading, filtered.length),
  );

  const rowKeyOf = $derived(pageScope.allProjects ? aggregateKeyFor : undefined);
  const groups = $derived(
    prGroups(
      sections,
      rowContext,
      now,
      rowKeyOf,
      pageScope.allProjects ? (pr) => qualified.byPr.get(pr)?.label ?? null : undefined,
    ),
  );
  const isSectionOpen = (key: string) => !listView.collapsedGroups[key];
  // A flat list has no section to name, so it draws no header.
  const virtualItems = $derived(
    virtualGroupItems<ListGroupSpec<PrRowSpec>, PrRowSpec>(groups, (row) => row.key, (group) => isSectionOpen(group.key)).filter(
      (item) => sectioned || item.kind === "row",
    ),
  );
  const activeVirtualKey = $derived(
    virtualItems.find(
      (item) => item.kind === "row" && item.row.key === selectedKey,
    )?.key ?? null,
  );

  const filterGroups = $derived(
    prFilterGroups(
      listView,
      { authors: prAuthorOptions(searched), labels: prLabelOptions(searched) },
      // Narrowing within what is loaded is free; the read key only moves when
      // the fetch scope does, so toggling Draft off and on costs no request.
      (next) => (listView.statusKeys = next),
    ),
  );
  const crumbGroups = $derived(
    filterGroups.filter((group) => group.key === "state" || group.key === "involvement"),
  );

  const synced = syncStamp(() => activeRefreshing);

  // The list's own order, as drawn — what ↑ / ↓, J / K, the panel stepper, and
  // the review's crumb switcher walk. A folded section's rows are not on
  // screen, so they are not walked either.
  const listNavigationItems = $derived(
    sections.filter((section) => !sectioned || isSectionOpen(section.key)).flatMap((section) => section.prs),
  );
  // Every row's identity, list-wide — unique across projects in All projects.
  const keyOf = $derived((pr: PullRequest) => rowKeyOf?.(pr) ?? String(pr.number));

  // Publish the visible order so the review's crumb switcher and its `n of N`
  // stepper walk exactly these rows, in exactly this order. Meaningful for the
  // single-project stepper only — All projects keeps its own local selection
  // below, since `prView.listOrder` is bare PR numbers.
  $effect(() => {
    if (pageScope.allProjects) return;
    const order = listNavigationItems.map((pr) => pr.number);
    untrack(() => {
      pullRequests.view.listOrder = order;
    });
  });

  // All projects keeps its own reading position: `PrsStore.listView` is reset
  // only on a *project* scope change and is keyed by bare number, which two
  // repos' identical PR numbers cannot share safely.
  let aggregateSelectedKey = $state<string | null>(null);
  let aggregateOpenKey = $state<string | null>(null);

  const selectedKey = $derived(
    pageScope.allProjects
      ? aggregateSelectedKey
      : (listView.selectedNumber !== null ? String(listView.selectedNumber) : null),
  );
  const openKey = $derived(
    pageScope.allProjects
      ? aggregateOpenKey
      : (listView.openNumber !== null ? String(listView.openNumber) : null),
  );

  function prByKey(key: string): PullRequest | undefined {
    return pageScope.allProjects
      ? qualified.byKey.get(key)?.pr
      : (shown?.items ?? []).find((pr) => String(pr.number) === key);
  }

  /** Which `(api, serverId, ctx)` a row's actions route through — the page's
   *  single scope, or that row's own project across every project. Null when
   *  no host is connected to route to, so callers skip rather than throw. */
  function targetFor(pr: PullRequest): PrTarget | null {
    const owner = pageScope.allProjects ? qualified.byPr.get(pr) : undefined;
    if (owner) return { api: owner.api, serverId: owner.serverId, ctx: owner.ctx }
    if (!pageScope.api || !pageScope.serverId) return null;
    return { api: pageScope.api, serverId: pageScope.serverId, ctx: pageScope.ctx() };
  }

  // The row lookups (checks, guides) key on the project alone, but
  // `pageScope.ctx()` builds a whole request context from the active tab, its
  // run, settings and the status bar. Called per row — inside the sort
  // comparator — that froze the list and made it depend on every session
  // event. Build it once per project, untracked.
  const lookupCtx = $derived.by(() => {
    void pageScope.projectPath;
    return untrack(() => pageScope.ctx());
  });

  /** The `(serverId, ctx)` a row's checks and guide are filed under. */
  function lookupScopeFor(pr: PullRequest): Pick<PrTarget, "serverId" | "ctx"> | null {
    const owner = pageScope.allProjects ? qualified.byPr.get(pr) : undefined;
    if (owner) return owner;
    return pageScope.serverId ? { serverId: pageScope.serverId, ctx: lookupCtx } : null;
  }

  const selectedPr = $derived(selectedKey ? (prByKey(selectedKey) ?? null) : null);
  const mergePr = $derived(mergeKey ? (prByKey(mergeKey) ?? null) : null);

  // ── The detail panel ──
  // A pull request comes out from the side of the list rather than replacing it:
  // the list narrows and the rows stay on screen so the queue is still readable
  // while one item is being reviewed. Below the width where both floors fit,
  // the panel covers the list instead — a phone cannot hold two columns.
  const openPr = $derived(openKey ? (prByKey(openKey) ?? null) : null);
  const openTarget = $derived(openPr ? targetFor(openPr) : null);
  const openPanel = $derived(
    openPr && openTarget ? { pr: openPr, target: openTarget } : null,
  );
  const panelOpen = $derived(
    showsPrDetailPanel(openPr !== null, openTarget !== null),
  );
  const roomForSplit = $derived(canSplitPrPanel(pageWidth));
  // Half the page until the reader drags the edge; the drag is remembered.
  let savedPanelWidth = $state(readSavedPrPanelWidth());
  const panelWidth = $derived(prPanelWidth(savedPanelWidth, pageWidth));
  const maxPanelWidth = $derived(clampPrPanelWidth(Number.POSITIVE_INFINITY, pageWidth));
  const panelFullScreen = $derived(
    panelOpen && (listView.panelFullScreen || !roomForSplit),
  );
  const splitList = $derived(panelOpen && !panelFullScreen);

  // ── The folding header ──
  // Scrolled past the narrowing row, the row folds into the crumb line as
  // `Pull requests / Open ▾ / All ▾`. It unfolds while the search field is in
  // use, and the crumb's search button unfolds it on purpose.
  let searchFocused = $state(false);
  let toolbarPinned = $state(false);
  const condensed = $derived(
    listView.scrollTop > 48 &&
      !listView.query &&
      !searchFocused &&
      !toolbarPinned,
  );
  function onSearchFocusChange(focused: boolean) {
    searchFocused = focused;
    if (!focused) toolbarPinned = false;
  }
  function unfoldSearch() {
    toolbarPinned = true;
    void tick().then(() => searchEl?.focus());
  }

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
    if (pageScope.allProjects) aggregateOpenKey = null;
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
    if (next && keyOf(next) !== openKey) selectPr(next, pullRequests.view.tab);
  }

  function openPrContextMenu(event: MouseEvent, pr: PullRequest) {
    event.preventDefault();
    event.stopPropagation();
    if (pageScope.allProjects) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
    prContextMenu = { pr, x: event.clientX, y: event.clientY };
  }

  function requestRowAction(pr: PullRequest, kind: PrRowActionKind) {
    if (kind === "merge") {
      mergeKey = keyOf(pr);
      mergeConfirmOpen = true;
    } else void runRowAction(pr, kind);
  }

  async function runRowAction(pr: PullRequest, kind: PrRowActionKind) {
    const target = targetFor(pr);
    if (!target) return;
    await runPrRowAction(store.get(target.api, target.serverId, target.ctx).get(pr.number), kind);
  }

  // ── Data loading ──

  // Repeated background reads can report the same failed projects. Notify
  // once per failure until a successful read clears it.
  let lastNotifiedPartialFailure = "";

  function notifyPartialFailure(): void {
    const failure = projectsFailure;
    if (failure.placement !== "toast") {
      lastNotifiedPartialFailure = "";
      return;
    }
    const key = failure.kind === "github-auth"
      ? `auth:${failure.serverId}`
      : `${failure.summary}\n${failure.detail}`;
    if (key === lastNotifiedPartialFailure) return;
    lastNotifiedPartialFailure = key;
    if (failure.kind === "github-auth") {
      toasts.error("GitHub is not connected", {
        action: {
          label: "Connect GitHub",
          onAction: () => shell.openResource({ kind: "connections", serverId: failure.serverId }),
        },
      });
    } else {
      toasts.error(failure.summary, {
        description: failure.detail,
        action: {
          label: "Retry",
          onAction: () => {
            lastNotifiedPartialFailure = "";
            readList(true);
          },
        },
      });
    }
  }

  // A change of project is the only scope trigger this effect reacts to.
  // `session.ctx` reads reactive git state (gitContext, changedFiles) that the
  // git watcher churns on every on-disk change, so the body is untracked:
  // normal git updates must not reset the page.
  //
  // The view state is NOT reset on a return from a review: opening a pull
  // request replaces this page, so every return re-runs this effect, and the
  // scroll position, section collapse and selection must survive the trip.
  let previousActiveScopeKey = "";
  $effect(() => {
    const scopeKey = pageScope.scopeKey;
    const everyProject = pageScope.allProjects;
    if (!open) return;
    untrack(() => {
      if (scopeKey && previousActiveScopeKey && scopeKey !== previousActiveScopeKey) {
        pullRequests.view.resetListView();
        reviewSelection.clear();
        beginScopeSwitch();
      }
      previousActiveScopeKey = scopeKey;
      if (!scopeKey && !everyProject) pullRequests.view.resetListView();
      if (scopeKey) shownScope();
      restoreReadingPosition();
    });
  });

  /** Holds the skeleton from the moment the scope changes. The rows on screen
   *  belong to the scope just left, so keeping them would show one project's
   *  pull requests under another project's title until the new read lands. The
   *  reads are dispatched in this same flush, so one `tick` is enough to learn
   *  whether there is anything to wait for. */
  function beginScopeSwitch(): void {
    scopeSwitch = "starting";
    void tick().then(() => {
      scopeSwitch = activeScopeReading ? "reading" : "idle";
    });
  }

  // The switch ends when the read it started ends. Only `reading` clears here,
  // so a later refresh of the same scope cannot end a switch, and a switch
  // whose scope had nothing to read has already gone `idle` above.
  $effect(() => {
    if (scopeSwitch === "reading" && !activeScopeReading) scopeSwitch = "idle";
  });

  /** The project the single-project list is showing, marked as the one on
   *  screen. Null when no host is connected — a real state, not an error. */
  function shownScope() {
    if (!pageScope.api || !pageScope.serverId) return null;
    const scope = store.get(pageScope.api, pageScope.serverId, pageScope.ctx());
    pullRequests.view.activeProjectKey = scope.key;
    return scope;
  }

  // What the list is reading, as one key: the scope, the fetch state, and the
  // search sent to the host. Any change is a new read; nothing else is. The
  // body is untracked because the targets carry live git context that the
  // watcher churns on every on-disk change.
  const listReadKey = $derived.by(() => {
    if (!open) return "";
    const scope = pageScope.allProjects ? pageScope.reachableKey : pageScope.scopeKey;
    return scope ? `${pageScope.allProjects ? "all" : "one"}\n${scope}\n${fetchScope}\n${search.hostQuery}` : "";
  });
  $effect(() => {
    if (!listReadKey) return;
    untrack(() => {
      readList();
      loadViewers();
    });
  });

  /** The projects this read covers, each created in the store on the way. */
  function readTargets(): ProjectPrs[] {
    if (!pageScope.allProjects) {
      const scope = shownScope();
      return scope ? [scope] : [];
    }
    return pageScope.projectTargets.map((project) => store.get(project.api, project.serverId, project.ctx));
  }

  /** Read the list the page is on, then the checks and guides for the rows it holds. */
  function readList(force = false): void {
    const scopes = readTargets();
    const readKey = listReadKey;
    void store
      .readPage(scopes, { ...listFilter }, {
        memoryKey: pageScope.allProjects ? "all" : pageScope.scopeKey,
        force,
        targets: pageScope.allProjects ? pageScope.projectTargets : undefined,
      })
      .then(() => {
        if (open && pageScope.allProjects && readKey === listReadKey) notifyPartialFailure();
        for (const scope of scopes) {
          void pullRequests.checks.load(
            scope.hostApi,
            scope.serverId,
            scope.hostContext,
            scope.items.map((pullRequest) => pullRequest.number),
          );
          void pullRequests.guides.loadListed(scope);
        }
      })
      .catch(() => {});
  }

  function loadViewers(): void {
    for (const scope of readTargets()) {
      void scope
        .loadViewer()
        .then((viewer) => viewerLogins.set(hostKey(scope.serverId, scope.projectScope), viewer.login))
        .catch(() => {});
    }
  }

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

  /** Pins the list to another project. Picking the input bar's own project
   *  releases the pin, so the list goes back to following it. The scope effect
   *  above owns forgetting the old list — it fires on any scope change, whether
   *  it came from here or from the input bar. */
  function selectProject(option: ListProjectOption): void {
    if (!option.available) return;
    session.scopePageToProject(option.key);
    aggregateSelectedKey = null;
    aggregateOpenKey = null;
    void tick().then(() => searchEl?.focus());
  }

  let observedPageScopeKey = "";
  $effect(() => {
    if (!open) return;
    const nextKey = pageScope.pageKey ?? "all";
    if (observedPageScopeKey === nextKey) return;
    observedPageScopeKey = nextKey;
    aggregateSelectedKey = null;
    aggregateOpenKey = null;
    reviewSelection.clear();
    void tick().then(() => searchEl?.focus());
  });

  function removeProjectHistory(option: ListProjectOption): void {
    projectsStore.removeProject(option.key);
  }

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeAllHosts(
      "prs.invalidated",
      (emittingServerId, { projectRoot: changedCwd }) => {
        if (!open) return;
        if (pageScope.allProjects) {
          if (!pageScope.projectTargets.some((project) => project.serverId === emittingServerId && project.projectRoot === changedCwd)) return;
          clearTimeout(timer);
          timer = setTimeout(() => readList(true), 500);
          return;
        }
        if (emittingServerId !== pageScope.serverId) return;
        const scopedCtx = pageScope.ctx().session;
        const ctxCwd = projectScopeOf(scopedCtx);
        if (changedCwd !== ctxCwd) return;
        clearTimeout(timer);
        timer = setTimeout(() => readList(true), 500);
      },
    );
    return () => {
      unsub();
      clearTimeout(timer);
    };
  });

  /** Open a pull request in the panel beside the list. The row stays selected,
   *  so closing the panel resumes the list on what was just read. */
  function selectPr(pr: PullRequest, tab?: PrReviewTab) {
    // The detail panel prepares a worktree, which only a workspace's host can
    // do; with none, the code host is where the pull request opens.
    if (!workspace) {
      void localApi.openExternal(pr.url);
      return;
    }
    const key = keyOf(pr);
    if (pageScope.allProjects) {
      aggregateSelectedKey = key;
      aggregateOpenKey = key;
    } else {
      listView.selectedNumber = pr.number;
      listView.openNumber = pr.number;
    }
    pullRequests.view.tab = tab ?? "activity";
    const target = targetFor(pr);
    if (target) store.get(target.api, target.serverId, target.ctx).get(pr.number).prefetch();
  }

  /** Arrow-key movement only highlights. Nothing is fetched or mounted until
   *  Enter opens the row, so walking the list costs no requests. */
  function highlightPr(pr: PullRequest) {
    if (pageScope.allProjects) aggregateSelectedKey = keyOf(pr);
    else listView.selectedNumber = pr.number;
  }


  function clearReviewSelection() {
    reviewSelection.clear();
    requestInputFocus();
  }

  function openReviewMode() {
    const items = selected.length > 0 ? selected : listNavigationItems;
    if (items.length === 0 || !workspace) return;
    if (reviewSelection.spansProjects) {
      toasts.error("Select pull requests from one project to start a review", {
        description: "Review Mode reviews one repository's checkout at a time.",
      });
      return;
    }
    const target = targetFor(items[0]);
    if (!target) return;
    void workspace.prReview.openReviewMode(items, target.ctx, target.serverId);
  }

  // ── Opt-in guide generation, for the checked rows ──
  const guideEligible = $derived(reviewSelection.guideEligible);
  const guidesInFlight = $derived(
    [...pullRequests.guides.status.values()].filter(
      (status) => status === "queued" || status === "generating",
    ).length,
  );

  function generateGuides() {
    if (!workspace) return;
    if (reviewSelection.spansProjects) {
      toasts.error("Select pull requests from one project to generate guides");
      return;
    }
    const target = guideEligible[0] ? targetFor(guideEligible[0]) : null;
    if (!target) return;
    const projectPath = target.ctx.session.projectPath ?? null;
    queueReviewGuides(pullRequests.guides, target, guideEligible.map((pr) => pr.number), () =>
      workspace.openPrs(projectPath),
    );
  }

  function clearFilters() {
    clearPrFilters(listView);
    searchEl?.focus();
  }

  // ── Keybindings ──
  // While the panel is open, Esc belongs to it: it collapses full screen, then
  // closes the review, and only an empty list page closes the page itself.
  useScope("prs", { active: () => open });
  // The one explicit way to scope the page to the input bar's project; the tab
  // in focus never does it by itself (docs/plans/project-model.md §5).
  useKeybinding("prs.current-project", () => {
    session.scopePageToCurrentProject();
  }, { enabled: () => open });
  useKeybinding("prs.close", () => close(), {
    enabled: () => open && !panelOpen,
  });
  function close() {
    workspace?.router.close("prs");
    requestInputFocus();
  }

  // ── List keyboard nav ──
  function onListKeydown(e: KeyboardEvent) {
    const rowAction = selectedPr ? prRowActionForKey(e, prRowActions(selectedPr)) : null;
    if (rowAction && selectedPr) {
      e.preventDefault();
      requestRowAction(selectedPr, rowAction);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
    } else if ((e.key === "x" || e.key === "X") && selectedPr && workspace) {
      // x checks the highlighted PR for review — keyboard-first multi-select,
      // matching the tasks list.
      e.preventDefault();
      reviewSelection.toggle(selectedPr);
    }
  }

  /** Ask every project with more rows for its next page. */
  function loadMoreAll() {
    for (const scope of paginating) {
      if (scope.hasMore && !scope.loading && !scope.loadingMore) void loadMore(scope);
    }
  }

  async function loadMore(scope: ProjectPrs): Promise<void> {
    await scope.loadMore();
    void pullRequests.guides.loadListed(scope);
    await pullRequests.checks.load(
      scope.hostApi,
      scope.serverId,
      scope.hostContext,
      scope.items.map((pullRequest) => pullRequest.number),
    );
  }
</script>

{#snippet pageActions()}
  {#if selected.length > 0 && workspace}
    <PrReviewActions
      selectedCount={selected.length}
      guideEligibleCount={guideEligible.length}
      {guidesInFlight}
      onClear={clearReviewSelection}
      onGenerateGuides={generateGuides}
      onReview={openReviewMode}
    />
  {/if}
{/snippet}

{#snippet filterBar()}
  <!-- One row in every shape the list takes, for one project or every one.
       Refresh joins the row only while the crumb line that carries it is gone. -->
  <PrListToolbar
    bind:query={listView.query}
    bind:searchEl
    bind:sortMode={listView.sortMode}
    sortOptions={SORT_OPTIONS}
    {filterGroups}
    projectFilter={splitList ? undefined : projectFilter}
    projectFilterActive={!splitList && !pageScope.allProjects && !!pageScope.pageKey}
    {onSearchFocusChange}
  />
{/snippet}

<!-- The narrow rail is navigation for the open detail: changing project there
     would replace the queue the reader is navigating from, so the rail's
     Filters menu leaves the project group out. -->
{#snippet projectFilter()}
  <ListProjectFilter
    projects={pageScope.projectOptions}
    activeKey={pageScope.allProjects ? "" : (pageScope.pageKey ?? "")}
    emptyLabel={pageScope.allProjects ? "All projects" : "No project"}
    onSelect={selectProject}
    onSelectAll={() => session.setProjectPageScope({ kind: "all" })}
    onSelectCurrent={() => session.scopePageToCurrentProject()}
    onRemoveHistory={workspace ? removeProjectHistory : undefined}
  />
{/snippet}

{#snippet condensedCrumbs()}
  <PrCondensedCrumbs groups={crumbGroups} onSearch={unfoldSearch} />
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
    {#if showPageSkeleton}
      <!-- This is the PR route's only loading state. The page root remains
           mounted so its width is known when a remembered detail panel returns
           after the read. -->
      <PrsPageSkeleton />
    {:else}
    <!-- A pull request comes out from the side of this list rather than
         replacing it. The list narrows and the review takes the width the
         reader last dragged it to, so the queue stays readable while one item
         is open; E gives the review the whole surface, and Esc walks that back
         one step at a time. -->
    <!-- The list resizes in one layout pass, in both directions. It can, because
         the panel beside it never shares this flow: it is positioned over the
         room this width leaves (see below), so neither opening nor closing makes
         the queue relayout frame by frame while the panel moves. -->
    <div
      class="flex min-h-0 min-w-0 shrink-0 {splitList ? '' : 'w-full'}"
      style={splitList ? `width: ${pageWidth - panelWidth}px` : undefined}
    >
    <ListPage
      split={splitList}
      page="prs"
      title={splitList ? "Pull Requests" : undefined}
      onRefresh={() => readList(true)}
      refreshing={activeRefreshing}
      syncedAt={synced.at}
      onMoveAcross={pane.inPane ? pane.moveAcross : undefined}
      isLeading={pane.isLeading}
      onClose={workspace ? close : undefined}
      actions={splitList ? undefined : pageActions}
      filters={filterBar}
      toolbarFilters
      contentOwnsScroll
      chromeHead={splitList}
      wrapFilters
      {condensed}
      {condensedCrumbs}
      bind:contentHeight
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div bind:this={listEl} onkeydown={onListKeydown} role="presentation" class="flex h-full min-h-0 flex-col">
        <div class="min-h-0 flex-1 overflow-hidden">
        <PrListStates
          allProjects={pageScope.allProjects}
          hasScope={!!pageScope.projectPath}
          scopeError={shown?.error ?? null}
          serverId={pageScope.serverId}
          {projectsFailure}
          hasItems={activeItems.length > 0}
          onRetry={() => readList(true)}
        >
        {#if groups.length === 0}
          <ListEmpty title="Nothing matches">
            Clear the filters or widen the search.
            {#snippet actions()}
              <Button
                type="button"
                class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                onclick={clearFilters}
              >
                Clear filters
              </Button>
              <!-- The rows loaded so far may all be filtered out while the host
                   still has more, so the next page can be asked for from here. -->
              {#if hasMorePullRequests && !loadCapped}
                <Button
                  type="button"
                  class="inline-flex h-8 cursor-pointer items-center rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
                  disabled={loadingMorePullRequests}
                  onclick={loadMoreAll}
                >
                  {loadingMorePullRequests ? "Loading more" : "Load more pull requests"}
                </Button>
              {/if}
            {/snippet}
          </ListEmpty>
        {:else}
          <PrListBody
            items={virtualItems}
            height={contentHeight}
            split={splitList}
            activeKey={activeVirtualKey}
            bind:scrollTop={listView.scrollTop}
            {selectedKey}
            reviewSelection={reviewSelection.keys}
            canReview={!!workspace}
            hasMore={hasMorePullRequests}
            loadingMore={loadingMorePullRequests}
            {loadCapped}
            showRowActions={shiftHeld.isHeld}
            {prByKey}
            {isSectionOpen}
            onToggleSection={(key) => (listView.collapsedGroups[key] = isSectionOpen(key))}
            onSelect={(pr) => selectPr(pr)}
            onContextMenu={openPrContextMenu}
            onToggleReview={(pr) => reviewSelection.toggle(pr)}
            onRowAction={requestRowAction}
            onLoadMore={loadMoreAll}
          />
        {/if}
        </PrListStates>
        </div>
      </div>
    </ListPage>
    </div>

    <!-- A one-item each block keeps its item value while the fly outro runs.
         An if block would keep evaluating openTarget after closePanel clears the
         open key, so the mounted child could read .ctx from null mid-outro. -->
    {#each openPanel ? [openPanel] : [] as panel}
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
          : 'absolute inset-y-0 right-0 z-10 min-w-0 shadow-[-1px_0_0_var(--hairline-strong)]'}"
        style={panelFullScreen ? undefined : `width: ${panelWidth}px`}
        transition:fly={{ x: 14, duration: reduceMotion ? 0 : 200 }}
      >
        {#if !panelFullScreen}
          <PrPanelResizeHandle
            width={panelWidth}
            maxWidth={maxPanelWidth}
            onResize={(width) => (savedPanelWidth = clampPrPanelWidth(width, pageWidth))}
            onCommit={(width) => savePrPanelWidth(clampPrPanelWidth(width, pageWidth))}
          />
        {/if}
        <!-- One panel per pull request: a step to another one mounts a new
             panel, which opens its review once. -->
        {#key keyOf(panel.pr)}
        <PrDetailPanel
          number={panel.pr.number}
          api={panel.target.api}
          serverId={panel.target.serverId}
          ctx={panel.target.ctx}
          title={panel.pr.title}
          baseRepo={panel.pr.baseRepo}
          fullScreen={panelFullScreen}
          onToggleFullScreen={roomForSplit ? toggleFullScreen : undefined}
          onClose={closePanel}
          onStep={stepPanel}
        />
        {/key}
      </div>
    {/each}

    {#if prContextMenu}
      {@const menuPr = prContextMenu.pr}
      <PrContextMenu
        x={prContextMenu.x}
        y={prContextMenu.y}
        pr={menuPr}
        onOpen={() => selectPr(menuPr)}
        onReview={() => selectPr(menuPr, "diff")}
        onOpenWeb={() => void localApi.openExternal(menuPr.url)}
        actions={prRowActions(menuPr)}
        onAction={(kind) => requestRowAction(menuPr, kind)}
        onClose={() => (prContextMenu = null)}
      />
    {/if}
    {#if mergePr}
      {@const merging = mergePr}
      <PrActionConfirm
        bind:open={mergeConfirmOpen}
        {...prMergeConfirmation(merging)}
        onConfirm={() => void runRowAction(merging, "merge")}
      />
    {/if}
    {/if}
  </div>
{/if}
